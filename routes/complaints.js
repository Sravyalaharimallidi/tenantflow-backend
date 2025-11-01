const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabase } = require('../config/supabase');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// File a complaint (Tenant)
router.post('/file-complaint', authenticateToken, authorizeRole(['tenant']), [
  body('complaintType').trim().isLength({ min: 2 }),
  body('title').trim().isLength({ min: 5, max: 255 }),
  body('description').trim().isLength({ min: 10 }),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  // roomId and propertyName are now required
  body('roomId').isUUID().withMessage('roomId is required and must be a valid UUID'),
  body('propertyName').trim().isLength({ min: 2 }).withMessage('propertyName is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { complaintType, title, description, priority = 'medium', roomId, propertyName } = req.body;

    // Get tenant details (including the property they belong to)
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select(`
        id, name, phone, room_number,
        properties!inner(id, name, owner_id)
      `)
      .eq('user_id', req.user.id)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant profile not found' });
    }

      // Verify the property exists
      const { data: propertyRecord, error: propErr } = await supabase
        .from('properties')
        .select('id, name, owner_id')
        .eq('id', propertyId)
        .single();

      if (propErr || !propertyRecord) {
        return res.status(400).json({ error: 'Property not found' });
      }

      // Verify the room exists and belongs to the provided property
      const { data: roomRecord, error: roomFetchError } = await supabase
        .from('rooms')
        .select('id, room_number, property_id')
        .eq('id', roomId)
        .single();

      if (roomFetchError || !roomRecord) {
        return res.status(400).json({ error: 'Room not found' });
      }

      if (roomRecord.property_id !== propertyRecord.id) {
        return res.status(400).json({ error: 'Room does not belong to the specified property' });
      }

    // Create complaint using the tenant's property id and validated room id
    const { data: complaint, error: complaintError } = await supabase
      .from('complaints')
      .insert({
        tenant_id: tenant.id,
        property_id: tenant.properties.id,
        room_id: roomId,
        complaint_type: complaintType,
        title,
        description,
        priority,
        status: 'pending'
      })
      .select()
      .single();

    if (complaintError) {
      return res.status(500).json({ error: 'Failed to file complaint' });
    }

    // Create notification for property's owner
    await supabase
      .from('notifications')
      .insert({
        user_id: propertyRecord.owner_id,
        title: 'New Complaint Filed',
        message: `New complaint from ${tenant.name}: ${title}`,
        type: 'complaint'
      });

    // Log activity
    await logActivity(req.user.id, 'create', 'complaints', complaint.id, null, complaint, req);

    res.status(201).json({
      message: 'Complaint filed successfully',
      complaint
    });
  } catch (error) {
    console.error('File complaint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get tenant's complaints
router.get('/my-complaints', authenticateToken, authorizeRole(['tenant']), async (req, res) => {
  try {
    // Get tenant ID
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant profile not found' });
    }

    // Get complaints with property and room details
    const { data: complaints, error } = await supabase
      .from('complaints')
      .select(`
        *,
        properties(name, address),
        rooms(room_number, room_type)
      `)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch complaints' });
    }

    res.json({ complaints });
  } catch (error) {
    console.error('Get tenant complaints error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get owner's complaints
router.get('/owner-complaints', authenticateToken, authorizeRole(['owner']), async (req, res) => {
  try {
    // Get owner ID
    const { data: owner } = await supabase
      .from('owners')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (!owner) {
      return res.status(404).json({ error: 'Owner profile not found' });
    }

    // Get complaints for owner's properties
    const { data: complaints, error } = await supabase
      .from('complaints')
      .select(`
        *,
        tenants(name, phone, room_number),
        properties(name, address),
        rooms(room_number, room_type)
      `)
      .eq('properties.owner_id', owner.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch complaints' });
    }

    res.json({ complaints });
  } catch (error) {
    console.error('Get owner complaints error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update complaint status (Owner)
router.put('/complaint/:complaintId/status', authenticateToken, authorizeRole(['owner']), [
  body('status').isIn(['pending', 'in_progress', 'resolved', 'closed']),
  body('response').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { complaintId } = req.params;
    const { status, response } = req.body;

    // Get owner ID
    const { data: owner } = await supabase
      .from('owners')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (!owner) {
      return res.status(404).json({ error: 'Owner profile not found' });
    }

    // Get complaint with verification
    const { data: complaint, error: fetchError } = await supabase
      .from('complaints')
      .select(`
        *,
        tenants!inner(name, user_id),
        properties!inner(owner_id)
      `)
      .eq('id', complaintId)
      .eq('properties.owner_id', owner.id)
      .single();

    if (fetchError || !complaint) {
      return res.status(404).json({ error: 'Complaint not found or access denied' });
    }

    // Update complaint
    const updateData = {
      status,
      updated_at: new Date().toISOString()
    };

    if (response) {
      updateData.owner_response = response;
    }

    if (status === 'resolved') {
      updateData.resolved_at = new Date().toISOString();
    }

    const { data: updatedComplaint, error } = await supabase
      .from('complaints')
      .update(updateData)
      .eq('id', complaintId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update complaint status' });
    }

    // Create notification for tenant
    await supabase
      .from('notifications')
      .insert({
        user_id: complaint.tenants.user_id,
        title: 'Complaint Status Updated',
        message: `Your complaint "${complaint.title}" status has been updated to ${status}.`,
        type: 'complaint'
      });

    // Log activity
    await logActivity(req.user.id, 'update', 'complaints', complaintId, { status: complaint.status }, { status }, req);

    res.json({
      message: 'Complaint status updated successfully',
      complaint: updatedComplaint
    });
  } catch (error) {
    console.error('Update complaint status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all complaints (Admin)
router.get('/all-complaints', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { status, priority, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('complaints')
      .select(`
        *,
        tenants(name, phone, room_number),
        properties(name, address, city),
        rooms(room_number, room_type),
        owners(name, business_name)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    if (priority) {
      query = query.eq('priority', priority);
    }

    const { data: complaints, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch complaints' });
    }

    // Get total count
    const { count } = await supabase
      .from('complaints')
      .select('*', { count: 'exact', head: true });

    res.json({
      complaints,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Get all complaints error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add admin notes to complaint
router.put('/complaint/:complaintId/admin-notes', authenticateToken, authorizeRole(['admin']), [
  body('notes').trim().isLength({ min: 5 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { complaintId } = req.params;
    const { notes } = req.body;

    // Update complaint with admin notes
    const { data: updatedComplaint, error } = await supabase
      .from('complaints')
      .update({
        admin_notes: notes,
        updated_at: new Date().toISOString()
      })
      .eq('id', complaintId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update complaint notes' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'complaints', complaintId, null, { admin_notes: notes }, req);

    res.json({
      message: 'Admin notes added successfully',
      complaint: updatedComplaint
    });
  } catch (error) {
    console.error('Add admin notes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get complaint statistics
router.get('/complaint-stats', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    // Get complaint counts by status
    const { data: statusCounts } = await supabase
      .from('complaints')
      .select('status')
      .then(result => {
        const counts = {};
        result.data.forEach(complaint => {
          counts[complaint.status] = (counts[complaint.status] || 0) + 1;
        });
        return { data: counts };
      });

    // Get complaint counts by priority
    const { data: priorityCounts } = await supabase
      .from('complaints')
      .select('priority')
      .then(result => {
        const counts = {};
        result.data.forEach(complaint => {
          counts[complaint.priority] = (counts[complaint.priority] || 0) + 1;
        });
        return { data: counts };
      });

    // Get recent complaints (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentComplaints } = await supabase
      .from('complaints')
      .select('id')
      .gte('created_at', thirtyDaysAgo.toISOString());

    res.json({
      statusCounts,
      priorityCounts,
      recentCount: recentComplaints.length,
      totalCount: Object.values(statusCounts).reduce((sum, count) => sum + count, 0)
    });
  } catch (error) {
    console.error('Get complaint stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
