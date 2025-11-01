const express = require('express');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { supabase } = require('../config/supabase');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = process.env.UPLOAD_PATH || './uploads';
    try {
      await fs.mkdir(uploadPath, { recursive: true });
      cb(null, uploadPath);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 // 5MB default
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and PDF files are allowed.'));
    }
  }
});

// Get tenant profile
router.get('/profile', authenticateToken, authorizeRole(['tenant']), async (req, res) => {
  try {
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select(`
        *,
        properties(name, address, city),
        rooms(room_number, room_type, rent_amount)
      `)
      .eq('user_id', req.user.id)
      .single();

    if (error || !tenant) {
      return res.status(404).json({ error: 'Tenant profile not found' });
    }

    res.json({ tenant });
  } catch (error) {
    console.error('Get tenant profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update tenant profile
router.put('/profile', authenticateToken, authorizeRole(['tenant']), [
  body('name').optional().trim().isLength({ min: 2 }),
  body('phone').optional().isMobilePhone(),
  body('emergencyContact').optional().isMobilePhone(),
  body('emergencyContactName').optional().trim().isLength({ min: 2 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, phone, emergencyContact, emergencyContactName } = req.body;

    // Get current tenant data
    const { data: currentTenant } = await supabase
      .from('tenants')
      .select('*')
      .eq('user_id', req.user.id)
      .single();

    if (!currentTenant) {
      return res.status(404).json({ error: 'Tenant profile not found' });
    }

    const updateData = {};
    const allowedFields = ['name', 'phone', 'emergency_contact', 'emergency_contact_name'];
    
    allowedFields.forEach(field => {
      const requestField = field === 'emergency_contact' ? 'emergencyContact' : 
                          field === 'emergency_contact_name' ? 'emergencyContactName' : field;
      if (req.body[requestField] !== undefined) {
        updateData[field] = req.body[requestField];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Update tenant profile
    const { data: updatedTenant, error } = await supabase
      .from('tenants')
      .update(updateData)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update tenant profile' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'tenants', updatedTenant.id, currentTenant, updatedTenant, req);

    res.json({
      message: 'Profile updated successfully',
      tenant: updatedTenant
    });
  } catch (error) {
    console.error('Update tenant profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload ID proof
router.post('/upload-id-proof', authenticateToken, authorizeRole(['tenant']), upload.single('idProof'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Get current tenant
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id, id_proof_url')
      .eq('user_id', req.user.id)
      .single();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant profile not found' });
    }

    // Update tenant with new ID proof URL
    const { data: updatedTenant, error } = await supabase
      .from('tenants')
      .update({ 
        id_proof_url: req.file.filename,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update ID proof' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'tenants', tenant.id, { id_proof_url: tenant.id_proof_url }, { id_proof_url: req.file.filename }, req);

    res.json({
      message: 'ID proof uploaded successfully',
      filename: req.file.filename
    });
  } catch (error) {
    console.error('Upload ID proof error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all tenants for owner
router.get('/owner-tenants', authenticateToken, authorizeRole(['owner']), async (req, res) => {
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

    // Get tenants from owner's properties
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select(`
        *,
        properties!inner(name, address),
        rooms(room_number, room_type, rent_amount),
        users(email, verification_status, last_login)
      `)
      .eq('properties.owner_id', owner.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch tenants' });
    }

    res.json({ tenants });
  } catch (error) {
    console.error('Get owner tenants error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update tenant profile (Owner - special cases)
router.put('/tenant/:tenantId/profile', authenticateToken, authorizeRole(['owner']), [
  body('name').optional().trim().isLength({ min: 2 }),
  body('phone').optional().isMobilePhone(),
  body('emergencyContact').optional().isMobilePhone(),
  body('emergencyContactName').optional().trim().isLength({ min: 2 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { tenantId } = req.params;
    const { name, phone, emergencyContact, emergencyContactName } = req.body;

    // Verify ownership through properties
    const { data: tenant, error: fetchError } = await supabase
      .from('tenants')
      .select(`
        *,
        properties!inner(owner_id)
      `)
      .eq('id', tenantId)
      .eq('properties.owner_id', req.user.id)
      .single();

    if (fetchError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found or access denied' });
    }

    const updateData = {};
    const allowedFields = ['name', 'phone', 'emergency_contact', 'emergency_contact_name'];
    
    allowedFields.forEach(field => {
      const requestField = field === 'emergency_contact' ? 'emergencyContact' : 
                          field === 'emergency_contact_name' ? 'emergencyContactName' : field;
      if (req.body[requestField] !== undefined) {
        updateData[field] = req.body[requestField];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Update tenant profile
    const { data: updatedTenant, error } = await supabase
      .from('tenants')
      .update(updateData)
      .eq('id', tenantId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update tenant profile' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'tenants', tenantId, tenant, updatedTenant, req);

    res.json({
      message: 'Tenant profile updated successfully',
      tenant: updatedTenant
    });
  } catch (error) {
    console.error('Update tenant profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all tenants (Admin)
router.get('/all-tenants', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('tenants')
      .select(`
        *,
        properties(name, address, city),
        rooms(room_number, room_type, rent_amount),
        users(email, verification_status, last_login, created_at),
        owners(name, business_name)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%,users.email.ilike.%${search}%`);
    }

    const { data: tenants, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch tenants' });
    }

    // Get total count
    const { count } = await supabase
      .from('tenants')
      .select('*', { count: 'exact', head: true });

    res.json({
      tenants,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Get all tenants error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get tenant statistics
router.get('/tenant-stats', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    // Get total tenant count
    const { count: totalTenants } = await supabase
      .from('tenants')
      .select('*', { count: 'exact', head: true });

    // Get tenants by verification status
    const { data: verificationStats } = await supabase
      .from('tenants')
      .select(`
        users!inner(verification_status)
      `)
      .then(result => {
        const stats = { pending: 0, approved: 0, rejected: 0 };
        result.data.forEach(tenant => {
          stats[tenant.users.verification_status] = (stats[tenant.users.verification_status] || 0) + 1;
        });
        return { data: stats };
      });

    // Get recent tenants (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentTenants } = await supabase
      .from('tenants')
      .select(`
        users!inner(created_at)
      `)
      .gte('users.created_at', thirtyDaysAgo.toISOString());

    res.json({
      totalTenants,
      verificationStats,
      recentCount: recentTenants.length
    });
  } catch (error) {
    console.error('Get tenant stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
