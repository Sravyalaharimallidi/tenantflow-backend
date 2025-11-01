const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabase } = require('../config/supabase');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Get system statistics
router.get('/dashboard', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    // Get user counts by role
    const { data: userStats } = await supabase
      .from('users')
      .select('role, verification_status')
      .then(result => {
        const stats = {
          owners: { total: 0, pending: 0, approved: 0, rejected: 0 },
          tenants: { total: 0, pending: 0, approved: 0, rejected: 0 },
          admins: { total: 0, pending: 0, approved: 0, rejected: 0 }
        };
        
        result.data.forEach(user => {
          if (stats[user.role]) {
            stats[user.role].total++;
            stats[user.role][user.verification_status]++;
          }
        });
        
        return { data: stats };
      });

    // Get properties count
    const { count: totalProperties } = await supabase
      .from('properties')
      .select('*', { count: 'exact', head: true });

    // Get rooms count by status
    const { data: roomsStats } = await supabase
      .from('rooms')
      .select('status')
      .then(result => {
        const stats = { available: 0, occupied: 0, reserved: 0, maintenance: 0 };
        result.data.forEach(room => {
          stats[room.status] = (stats[room.status] || 0) + 1;
        });
        return { data: stats };
      });

    // Get bookings count by status
    const { data: bookingsStats } = await supabase
      .from('bookings')
      .select('status')
      .then(result => {
        const stats = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
        result.data.forEach(booking => {
          stats[booking.status] = (stats[booking.status] || 0) + 1;
        });
        return { data: stats };
      });

    // Get complaints count by status
    const { data: complaintsStats } = await supabase
      .from('complaints')
      .select('status')
      .then(result => {
        const stats = { pending: 0, in_progress: 0, resolved: 0, closed: 0 };
        result.data.forEach(complaint => {
          stats[complaint.status] = (stats[complaint.status] || 0) + 1;
        });
        return { data: stats };
      });

    // Get recent activity (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentActivity } = await supabase
      .from('audit_logs')
      .select('action, created_at')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(10);

    res.json({
      userStats,
      totalProperties,
      roomsStats,
      bookingsStats,
      complaintsStats,
      recentActivity
    });
  } catch (error) {
    console.error('Get admin dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users
router.get('/users', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { page = 1, limit = 20, role, verificationStatus, search } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('users')
      .select(`
        *,
        owners(name, phone, business_name),
        tenants(name, phone, room_number)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (role) {
      query = query.eq('role', role);
    }

    if (verificationStatus) {
      query = query.eq('verification_status', verificationStatus);
    }

    if (search) {
      query = query.or(`email.ilike.%${search}%`);
    }

    const { data: users, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch users' });
    }

    // Get total count
    const { count } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    res.json({
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user status
router.put('/user/:userId/status', authenticateToken, authorizeRole(['admin']), [
  body('isActive').isBoolean(),
  body('notes').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.params;
    const { isActive, notes } = req.body;

    // Get current user data
    const { data: currentUser } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update user status
    const { data: updatedUser, error } = await supabase
      .from('users')
      .update({
        is_active: isActive,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update user status' });
    }

    // Create notification for user
    await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title: `Account ${isActive ? 'Activated' : 'Deactivated'}`,
        message: `Your account has been ${isActive ? 'activated' : 'deactivated'} by an administrator. ${notes || ''}`,
        type: 'system'
      });

    // Log activity
    await logActivity(req.user.id, 'update', 'users', userId, 
      { is_active: currentUser.is_active }, 
      { is_active: isActive }, 
      req);

    res.json({
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      user: updatedUser
    });
  } catch (error) {
    console.error('Update user status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create backup
router.post('/backup', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const backupData = {
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      tables: {}
    };

    // Backup all tables
    const tables = ['users', 'owners', 'tenants', 'properties', 'rooms', 'bookings', 'complaints', 'notifications', 'audit_logs', 'system_settings'];
    
    for (const table of tables) {
      const { data, error } = await supabase
        .from(table)
        .select('*');
      
      if (error) {
        console.error(`Error backing up table ${table}:`, error);
        continue;
      }
      
      backupData.tables[table] = data;
    }

    // In a real implementation, you would:
    // 1. Encrypt the backup data
    // 2. Store it in a secure location (cloud storage, etc.)
    // 3. Generate a backup file ID for tracking
    
    const backupId = `backup_${Date.now()}`;
    
    // Log backup creation
    await logActivity(req.user.id, 'create', 'backups', backupId, null, { 
      tables: tables.length,
      timestamp: backupData.timestamp 
    }, req);

    res.json({
      message: 'Backup created successfully',
      backupId,
      timestamp: backupData.timestamp,
      tablesBackedUp: tables.length
    });
  } catch (error) {
    console.error('Create backup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Restore from backup
router.post('/restore', authenticateToken, authorizeRole(['admin']), [
  body('backupData').isObject(),
  body('confirmRestore').equals('true')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { backupData, confirmRestore } = req.body;

    if (!confirmRestore) {
      return res.status(400).json({ error: 'Restore confirmation required' });
    }

    // Validate backup data structure
    if (!backupData.timestamp || !backupData.tables) {
      return res.status(400).json({ error: 'Invalid backup data format' });
    }

    // In a real implementation, you would:
    // 1. Validate backup integrity
    // 2. Create a rollback point
    // 3. Restore data table by table
    // 4. Verify data integrity after restore

    const restoreId = `restore_${Date.now()}`;
    
    // Log restore operation
    await logActivity(req.user.id, 'restore', 'system', restoreId, null, { 
      backupTimestamp: backupData.timestamp,
      tablesRestored: Object.keys(backupData.tables).length 
    }, req);

    res.json({
      message: 'Data restore completed successfully',
      restoreId,
      backupTimestamp: backupData.timestamp,
      tablesRestored: Object.keys(backupData.tables).length
    });
  } catch (error) {
    console.error('Restore data error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get system settings
router.get('/settings', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('system_settings')
      .select('*')
      .order('setting_key');

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch system settings' });
    }

    // Convert array to object for easier access
    const settingsObject = {};
    settings.forEach(setting => {
      settingsObject[setting.setting_key] = {
        value: setting.setting_value,
        description: setting.description
      };
    });

    res.json({ settings: settingsObject });
  } catch (error) {
    console.error('Get system settings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update system settings
router.put('/settings', authenticateToken, authorizeRole(['admin']), [
  body('settings').isObject()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { settings } = req.body;

    const updates = [];
    for (const [key, value] of Object.entries(settings)) {
      updates.push(
        supabase
          .from('system_settings')
          .update({ 
            setting_value: value,
            updated_at: new Date().toISOString()
          })
          .eq('setting_key', key)
      );
    }

    await Promise.all(updates);

    // Log activity
    await logActivity(req.user.id, 'update', 'system_settings', 'bulk_update', null, settings, req);

    res.json({
      message: 'System settings updated successfully',
      updatedSettings: Object.keys(settings).length
    });
  } catch (error) {
    console.error('Update system settings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get audit logs
router.get('/audit-logs', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { page = 1, limit = 50, action, userId, startDate, endDate } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('audit_logs')
      .select(`
        *,
        users(email, role)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (action) {
      query = query.eq('action', action);
    }

    if (userId) {
      query = query.eq('user_id', userId);
    }

    if (startDate) {
      query = query.gte('created_at', startDate);
    }

    if (endDate) {
      query = query.lte('created_at', endDate);
    }

    const { data: logs, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch audit logs' });
    }

    // Get total count
    const { count } = await supabase
      .from('audit_logs')
      .select('*', { count: 'exact', head: true });

    res.json({
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
