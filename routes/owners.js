const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabase } = require('../config/supabase');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get owner profile
router.get('/profile', authenticateToken, authorizeRole(['owner']), async (req, res) => {
  try {
    const { data: owner, error } = await supabase
      .from('owners')
      .select(`
        *,
        users(email, verification_status, last_login, created_at)
      `)
      .eq('user_id', req.user.id)
      .single();

    if (error || !owner) {
      return res.status(404).json({ error: 'Owner profile not found' });
    }

    res.json({ owner });
  } catch (error) {
    console.error('Get owner profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update owner profile
router.put('/profile', authenticateToken, authorizeRole(['owner']), [
  body('name').optional().trim().isLength({ min: 2 }),
  body('phone').optional().isMobilePhone(),
  body('businessName').optional().trim().isLength({ min: 2 }),
  body('businessAddress').optional().trim().isLength({ min: 10 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, phone, businessName, businessAddress } = req.body;

    // Get current owner data
    const { data: currentOwner } = await supabase
      .from('owners')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (!currentOwner) {
      return res.status(404).json({ error: 'Owner profile not found' });
    }

    const updateData = {};
    const allowedFields = ['name', 'phone', 'business_name', 'business_address'];
    
    allowedFields.forEach(field => {
      const requestField = field === 'business_name' ? 'businessName' : 
                          field === 'business_address' ? 'businessAddress' : field;
      if (req.body[requestField] !== undefined) {
        updateData[field] = req.body[requestField];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Update owner profile
    const { data: updatedOwner, error } = await supabase
      .from('owners')
      .update(updateData)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update owner profile' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'owners', updatedOwner.id, currentOwner, updatedOwner, req);

    res.json({
      message: 'Profile updated successfully',
      owner: updatedOwner
    });
  } catch (error) {
    console.error('Update owner profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all owners (Admin)
router.get('/all-owners', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { page = 1, limit = 20, search, verificationStatus } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('owners')
      .select(`
        *,
        users(email, verification_status, last_login, created_at, is_active)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`name.ilike.%${search}%,business_name.ilike.%${search}%,users.email.ilike.%${search}%`);
    }

    if (verificationStatus) {
      query = query.eq('users.verification_status', verificationStatus);
    }

    const { data: owners, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch owners' });
    }

    // Get total count
    const { count } = await supabase
      .from('owners')
      .select('*', { count: 'exact', head: true });

    res.json({
      owners,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Get all owners error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve/Reject owner registration (Admin)
router.put('/owner/:ownerId/verification', authenticateToken, authorizeRole(['admin']), [
  body('status').isIn(['approved', 'rejected']),
  body('notes').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { ownerId } = req.params;
    const { status, notes } = req.body;

    // Get owner with user details
    const { data: owner, error: fetchError } = await supabase
      .from('owners')
      .select(`
        *,
        users!inner(id, email, verification_status)
      `)
      .eq('id', ownerId)
      .single();

    if (fetchError || !owner) {
      return res.status(404).json({ error: 'Owner not found' });
    }

    if (owner.users.verification_status !== 'pending') {
      return res.status(400).json({ error: 'Owner verification status is not pending' });
    }

    // Update user verification status and role
    const { data: updatedUser, error: userError } = await supabase
      .from('users')
      .update({
        verification_status: status,
        role: status === 'approved' ? 'owner' : 'tenant', // Set role to owner if approved
        updated_at: new Date().toISOString()
      })
      .eq('id', owner.users.id)
      .select()
      .single();

    if (userError) {
      return res.status(500).json({ error: 'Failed to update verification status' });
    }

    // Create notification for owner
    await supabase
      .from('notifications')
      .insert({
        user_id: owner.users.id,
        title: `Registration ${status === 'approved' ? 'Approved' : 'Rejected'}`,
        message: `Your owner registration has been ${status === 'approved' ? 'approved' : 'rejected'}. ${notes || ''}`,
        type: 'verification'
      });

    // Log activity
    await logActivity(req.user.id, 'update', 'users', owner.users.id, 
      { verification_status: 'pending' }, 
      { verification_status: status }, 
      req);

    res.json({
      message: `Owner registration ${status} successfully`,
      owner: {
        ...owner,
        users: updatedUser
      }
    });
  } catch (error) {
    console.error('Update owner verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get owner statistics
router.get('/owner-stats', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    // Get total owner count
    const { count: totalOwners } = await supabase
      .from('owners')
      .select('*', { count: 'exact', head: true });

    // Get owners by verification status
    const { data: verificationStats } = await supabase
      .from('owners')
      .select(`
        users!inner(verification_status)
      `)
      .then(result => {
        const stats = { pending: 0, approved: 0, rejected: 0 };
        result.data.forEach(owner => {
          stats[owner.users.verification_status] = (stats[owner.users.verification_status] || 0) + 1;
        });
        return { data: stats };
      });

    // Get recent owners (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentOwners } = await supabase
      .from('owners')
      .select(`
        users!inner(created_at)
      `)
      .gte('users.created_at', thirtyDaysAgo.toISOString());

    // Get owners with properties count
    const { data: ownersWithProperties } = await supabase
      .from('owners')
      .select(`
        id,
        properties(count)
      `);

    const ownersWithPropertiesCount = ownersWithProperties.filter(owner => owner.properties.length > 0).length;

    res.json({
      totalOwners,
      verificationStats,
      recentCount: recentOwners.length,
      ownersWithProperties: ownersWithPropertiesCount
    });
  } catch (error) {
    console.error('Get owner stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Owner Dashboard
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Access denied' });
    }
    // Get ownerId for this user
    const { data: owner, error: ownerErr } = await supabase.from('owners').select('id').eq('user_id', req.user.id).single();
    if (!owner) return res.status(404).json({ error: 'Owner not found' });
    // Properties count
    const { data: properties, error: propsError } = await supabase.from('properties').select('id').eq('owner_id', owner.id);
    const propertiesCount = properties ? properties.length : 0;
    const propertyIds = properties.map(p => p.id);
    // Room stats
    let roomsStats = { available:0, occupied:0, reserved:0, maintenance:0 };
    let rooms = [];
    if (propertyIds.length > 0) {
      const { data: roomRows, error: roomsError } = await supabase.from('rooms').select('status').in('property_id', propertyIds);
      if (roomRows) {
        rooms = roomRows;
        roomRows.forEach(r => { roomsStats[r.status] = (roomsStats[r.status]||0)+1; });
      }
    }
    // Optionally, count pendingBookings, pendingComplaints (stub for now):
    let pendingBookings = 0;
    let pendingComplaints = 0;
    // If you want live: get bookings/complaints for these rooms/properties and count with status === 'pending'
    // Response structure matches frontend usage:
    res.status(200).json({
      stats: {
        propertiesCount,
        roomsStats,
        pendingBookings,  // enhance if needed
        pendingComplaints // enhance if needed
      },
      roomsCount: rooms.length,
      propertiesCount
    });
  } catch (error) {
    console.error('Error fetching owner dashboard data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
