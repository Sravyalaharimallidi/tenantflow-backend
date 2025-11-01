const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabase } = require('../config/supabase');
const { 
  generateToken, 
  hashPassword, 
  comparePassword, 
  authenticateToken,
  logActivity,
  validatePassword 
} = require('../middleware/auth');

const router = express.Router();

// Owner Registration
router.post('/register/owner', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').trim().isLength({ min: 2 }),
  body('phone').isMobilePhone(),
  body('businessName').trim().isLength({ min: 2 }),
  body('businessAddress').trim().isLength({ min: 10 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, phone, businessName, businessAddress, verificationDocuments } = req.body;

    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({ 
        error: 'Password does not meet requirements',
        details: passwordValidation.errors 
      });
    }

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        email,
        password_hash: passwordHash,
        role: 'owner',
        verification_status: 'pending'
      })
      .select()
      .single();

    if (userError) {
      return res.status(500).json({ error: 'Failed to create user account' });
    }

    // Create owner profile
    const { data: owner, error: ownerError } = await supabase
      .from('owners')
      .insert({
        user_id: user.id,
        name,
        phone,
        business_name: businessName,
        business_address: businessAddress,
        verification_documents: verificationDocuments || {}
      })
      .select()
      .single();

    if (ownerError) {
      // Clean up user if owner creation fails
      await supabase.from('users').delete().eq('id', user.id);
      return res.status(500).json({ error: 'Failed to create owner profile' });
    }

    // Log registration activity
    await logActivity(user.id, 'register', 'users', user.id, null, { email, role: 'owner' }, req);

    res.status(201).json({
      message: 'Owner registration successful. Account pending verification.',
      userId: user.id,
      verificationStatus: 'pending'
    });

  } catch (error) {
    console.error('Owner registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Owner Login
router.post('/login/owner', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Get user with owner details
    const { data: user, error } = await supabase
      .from('users')
      .select(`
        id, email, password_hash, role, verification_status, is_active, last_login,
        owners!inner(id, name, phone, business_name)
      `)
      .eq('email', email)
      .eq('role', 'owner')
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    // Verify password
    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    // Generate token
    const token = generateToken(user.id, user.role);

    // Log login activity
    await logActivity(user.id, 'login', 'users', user.id, null, { login_time: new Date() }, req);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        verificationStatus: user.verification_status,
        owner: user.owners
      }
    });

  } catch (error) {
    console.error('Owner login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Tenant Login (two types: with room number or with password)
router.post('/login/tenant', [
  body('email').isEmail().normalizeEmail(),
  body('hasBookedRoom').isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, roomNumber, password, hasBookedRoom } = req.body;

    let tenant, error;

    if (hasBookedRoom) {
      // Login with room number (for tenants who have booked a room)
      if (!roomNumber) {
        return res.status(400).json({ error: 'Room number is required for booked tenants' });
      }

      const result = await supabase
        .from('tenants')
        .select(`
          id, name, phone, room_number,
          users!inner(id, email, password_hash, role, verification_status, is_active, last_login)
        `)
        .eq('users.email', email)
        .eq('room_number', roomNumber)
        .eq('users.role', 'tenant')
        .single();
      
      tenant = result.data;
      error = result.error;
    } else {
      // Login with password (for tenants who haven't booked a room yet)
      if (!password) {
        return res.status(400).json({ error: 'Password is required for non-booked tenants' });
      }

      const result = await supabase
        .from('tenants')
        .select(`
          id, name, phone, room_number,
          users!inner(id, email, password_hash, role, verification_status, is_active, last_login)
        `)
        .eq('users.email', email)
        .eq('users.role', 'tenant')
        .single();
      
      tenant = result.data;
      error = result.error;

      // Verify password for non-booked tenants
      if (tenant && !error) {
        const isPasswordValid = await comparePassword(password, tenant.users.password_hash);
        if (!isPasswordValid) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }
      }
    }

    if (error || !tenant) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!tenant.users.is_active) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', tenant.users.id);

    // Generate token
    const token = generateToken(tenant.users.id, tenant.users.role);

    // Log login activity
    await logActivity(tenant.users.id, 'login', 'users', tenant.users.id, null, { login_time: new Date() }, req);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: tenant.users.id,
        email: tenant.users.email,
        role: tenant.users.role,
        verificationStatus: tenant.users.verification_status,
        tenant: {
          id: tenant.id,
          name: tenant.name,
          phone: tenant.phone,
          roomNumber: tenant.room_number
        }
      }
    });

  } catch (error) {
    console.error('Tenant login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Login
router.post('/login/admin', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Get admin user
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, password_hash, role, verification_status, is_active, last_login')
      .eq('email', email)
      .eq('role', 'admin')
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    // Verify password
    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    // Generate token
    const token = generateToken(user.id, user.role);

    // Log login activity
    await logActivity(user.id, 'login', 'users', user.id, null, { login_time: new Date() }, req);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        verificationStatus: user.verification_status
      }
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Tenant Registration
router.post('/register/tenant', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().isLength({ min: 2 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, roomNumber, phone } = req.body;

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        email,
        password_hash: passwordHash,
        role: 'tenant',
        verification_status: 'pending'
      })
      .select()
      .single();

    if (userError) {
      return res.status(500).json({ error: 'Failed to create user account' });
    }

    // Create tenant profile
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({
        user_id: user.id,
        name,
        phone: phone || null,
        room_number: roomNumber || null // Allow null for room_number
      })
      .select()
      .single();

    if (tenantError) {
      await supabase.from('users').delete().eq('id', user.id);
      return res.status(500).json({ error: 'Failed to create tenant profile' });
    }

    // Log registration activity
    await logActivity(user.id, 'register', 'users', user.id, null, { email, role: 'tenant' }, req);

    res.status(201).json({
      message: 'Tenant registration successful. Account pending verification.',
      userId: user.id,
      verificationStatus: 'pending'
    });
  } catch (error) {
    console.error('Tenant registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Registration
router.post('/register/admin', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').trim().isLength({ min: 2 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name } = req.body;

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        email,
        password_hash: passwordHash,
        role: 'admin',
        verification_status: 'approved'
      })
      .select()
      .single();

    if (userError) {
      return res.status(500).json({ error: 'Failed to create admin account' });
    }

    res.status(201).json({
      message: 'Admin registration successful.',
      userId: user.id
    });
  } catch (error) {
    console.error('Admin registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token endpoint
router.get('/verify', authenticateToken, (req, res) => {
  res.json({
    valid: true,
    user: req.user
  });
});

// Logout (client-side token removal)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // Log logout activity
    await logActivity(req.user.id, 'logout', 'users', req.user.id, null, { logout_time: new Date() }, req);
    
    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fetch pending owner approval requests
router.get('/approval-requests', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: requests, error } = await supabase
      .from('users')
      .select('id, email, created_at')
      .eq('role', 'owner')
      .eq('verification_status', 'pending');

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch approval requests' });
    }

    res.status(200).json({ requests });
  } catch (error) {
    console.error('Error fetching approval requests:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve or reject owner approval requests
router.post('/approval-requests/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id } = req.params;
    const { action } = req.body; // action can be 'approve' or 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const { error } = await supabase
      .from('users')
      .update({ verification_status: action === 'approve' ? 'approved' : 'rejected' })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Failed to update approval status' });
    }

    res.status(200).json({ message: `Owner ${action}d successfully` });
  } catch (error) {
    console.error('Error updating approval status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
