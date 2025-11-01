const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { supabase } = require('../config/supabase');

// Generate JWT token
const generateToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// Verify JWT token
const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid token');
  }
};

// Hash password
const hashPassword = async (password) => {
  const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
  return await bcrypt.hash(password, saltRounds);
};

// Compare password
const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = verifyToken(token);
    
    // Verify user still exists and is active
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, role, verification_status, is_active')
      .eq('id', decoded.userId)
      .single();

    if (error || !user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Role-based authorization middleware
const authorizeRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
};

// Owner verification middleware
const requireOwnerVerification = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }

  if (req.user.verification_status !== 'approved') {
    return res.status(403).json({ error: 'Owner account not verified' });
  }

  next();
};

// Log user activity
const logActivity = async (userId, action, tableName, recordId, oldValues = null, newValues = null, req = null) => {
  try {
    await supabase
      .from('audit_logs')
      .insert({
        user_id: userId,
        action,
        table_name: tableName,
        record_id: recordId,
        old_values: oldValues,
        new_values: newValues,
        ip_address: req ? req.ip : null,
        user_agent: req ? req.get('User-Agent') : null
      });
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
};

// Validate password strength
const validatePassword = (password) => {
  const minLength = 8;
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  const errors = [];
  
  if (password.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters long`);
  }
  if (!hasUpperCase) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!hasLowerCase) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!hasNumbers) {
    errors.push('Password must contain at least one number');
  }
  if (!hasSpecialChar) {
    errors.push('Password must contain at least one special character');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

module.exports = {
  generateToken,
  verifyToken,
  hashPassword,
  comparePassword,
  authenticateToken,
  authorizeRole,
  requireOwnerVerification,
  logActivity,
  validatePassword
};
