const express = require('express');
const nodemailer = require('nodemailer');
const { body, validationResult } = require('express-validator');
const { supabase } = require('../config/supabase');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Configure email transporter
const createEmailTransporter = () => {
  return nodemailer.createTransporter({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

// Send email notification
const sendEmailNotification = async (to, subject, text, html = null) => {
  try {
    const transporter = createEmailTransporter();
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to,
      subject,
      text,
      html: html || text
    };

    const result = await transporter.sendMail(mailOptions);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Email sending error:', error);
    return { success: false, error: error.message };
  }
};

// Send SMS notification (placeholder - integrate with actual SMS service)
const sendSMSNotification = async (phoneNumber, message) => {
  try {
  // In a real implementation, integrate with SMS service like Twilio, AWS SNS, etc.
  // Placeholder: do not log SMS content to avoid sensitive data leakage
    return { success: true, messageId: `sms_${Date.now()}` };
  } catch (error) {
    console.error('SMS sending error:', error);
    return { success: false, error: error.message };
  }
};

// Get user notifications
router.get('/my-notifications', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, isRead } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (isRead !== undefined) {
      query = query.eq('is_read', isRead === 'true');
    }

    const { data: notifications, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch notifications' });
    }

    // Get total count
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id);

    res.json({
      notifications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark notification as read
router.put('/notification/:notificationId/read', authenticateToken, async (req, res) => {
  try {
    const { notificationId } = req.params;

    const { data: notification, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notificationId)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error || !notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({
      message: 'Notification marked as read',
      notification
    });
  } catch (error) {
    console.error('Mark notification as read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark all notifications as read
router.put('/mark-all-read', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false)
      .select();

    if (error) {
      return res.status(500).json({ error: 'Failed to mark notifications as read' });
    }

    res.json({
      message: 'All notifications marked as read',
      updatedCount: data.length
    });
  } catch (error) {
    console.error('Mark all notifications as read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send notification (Admin)
router.post('/send-notification', authenticateToken, authorizeRole(['admin']), [
  body('userId').isUUID(),
  body('title').trim().isLength({ min: 1, max: 255 }),
  body('message').trim().isLength({ min: 1 }),
  body('type').optional().isIn(['system', 'booking', 'complaint', 'verification']),
  body('sendEmail').optional().isBoolean(),
  body('sendSMS').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId, title, message, type = 'system', sendEmail = false, sendSMS = false } = req.body;

    // Verify user exists
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, role')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create notification
    const { data: notification, error: notificationError } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title,
        message,
        type,
        email_sent: false,
        sms_sent: false
      })
      .select()
      .single();

    if (notificationError) {
      return res.status(500).json({ error: 'Failed to create notification' });
    }

    let emailResult = null;
    let smsResult = null;

    // Send email if requested
    if (sendEmail && user.email) {
      emailResult = await sendEmailNotification(
        user.email,
        title,
        message
      );

      if (emailResult.success) {
        await supabase
          .from('notifications')
          .update({ email_sent: true })
          .eq('id', notification.id);
      }
    }

    // Send SMS if requested
    if (sendSMS) {
      // Get user's phone number based on role
      let phoneNumber = null;
      if (user.role === 'owner') {
        const { data: owner } = await supabase
          .from('owners')
          .select('phone')
          .eq('user_id', userId)
          .single();
        phoneNumber = owner?.phone;
      } else if (user.role === 'tenant') {
        const { data: tenant } = await supabase
          .from('tenants')
          .select('phone')
          .eq('user_id', userId)
          .single();
        phoneNumber = tenant?.phone;
      }

      if (phoneNumber) {
        smsResult = await sendSMSNotification(phoneNumber, message);
        
        if (smsResult.success) {
          await supabase
            .from('notifications')
            .update({ sms_sent: true })
            .eq('id', notification.id);
        }
      }
    }

    // Log activity
    await logActivity(req.user.id, 'create', 'notifications', notification.id, null, {
      title,
      type,
      email_sent: emailResult?.success || false,
      sms_sent: smsResult?.success || false
    }, req);

    res.status(201).json({
      message: 'Notification sent successfully',
      notification,
      emailResult,
      smsResult
    });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send bulk notification (Admin)
router.post('/send-bulk-notification', authenticateToken, authorizeRole(['admin']), [
  body('userIds').isArray({ min: 1 }),
  body('title').trim().isLength({ min: 1, max: 255 }),
  body('message').trim().isLength({ min: 1 }),
  body('type').optional().isIn(['system', 'booking', 'complaint', 'verification']),
  body('sendEmail').optional().isBoolean(),
  body('sendSMS').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userIds, title, message, type = 'system', sendEmail = false, sendSMS = false } = req.body;

    // Verify users exist
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, email, role')
      .in('id', userIds);

    if (usersError) {
      return res.status(500).json({ error: 'Failed to verify users' });
    }

    if (users.length !== userIds.length) {
      return res.status(400).json({ error: 'Some users not found' });
    }

    // Create notifications for all users
    const notifications = userIds.map(userId => ({
      user_id: userId,
      title,
      message,
      type,
      email_sent: false,
      sms_sent: false
    }));

    const { data: createdNotifications, error: notificationError } = await supabase
      .from('notifications')
      .insert(notifications)
      .select();

    if (notificationError) {
      return res.status(500).json({ error: 'Failed to create notifications' });
    }

    let emailResults = [];
    let smsResults = [];

    // Send emails if requested
    if (sendEmail) {
      for (const user of users) {
        if (user.email) {
          const result = await sendEmailNotification(user.email, title, message);
          emailResults.push({ userId: user.id, result });
          
          if (result.success) {
            await supabase
              .from('notifications')
              .update({ email_sent: true })
              .eq('user_id', user.id)
              .eq('title', title)
              .eq('created_at', new Date().toISOString().split('T')[0]);
          }
        }
      }
    }

    // Send SMS if requested
    if (sendSMS) {
      for (const user of users) {
        let phoneNumber = null;
        if (user.role === 'owner') {
          const { data: owner } = await supabase
            .from('owners')
            .select('phone')
            .eq('user_id', user.id)
            .single();
          phoneNumber = owner?.phone;
        } else if (user.role === 'tenant') {
          const { data: tenant } = await supabase
            .from('tenants')
            .select('phone')
            .eq('user_id', user.id)
            .single();
          phoneNumber = tenant?.phone;
        }

        if (phoneNumber) {
          const result = await sendSMSNotification(phoneNumber, message);
          smsResults.push({ userId: user.id, result });
          
          if (result.success) {
            await supabase
              .from('notifications')
              .update({ sms_sent: true })
              .eq('user_id', user.id)
              .eq('title', title)
              .eq('created_at', new Date().toISOString().split('T')[0]);
          }
        }
      }
    }

    // Log activity
    await logActivity(req.user.id, 'create', 'notifications', 'bulk', null, {
      title,
      type,
      userCount: userIds.length,
      email_sent: sendEmail,
      sms_sent: sendSMS
    }, req);

    res.status(201).json({
      message: 'Bulk notification sent successfully',
      notificationsCreated: createdNotifications.length,
      emailResults,
      smsResults
    });
  } catch (error) {
    console.error('Send bulk notification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get notification statistics
router.get('/notification-stats', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    // Get notification counts by type
    const { data: typeStats } = await supabase
      .from('notifications')
      .select('type')
      .then(result => {
        const stats = {};
        result.data.forEach(notification => {
          stats[notification.type] = (stats[notification.type] || 0) + 1;
        });
        return { data: stats };
      });

    // Get read/unread counts
    const { data: readStats } = await supabase
      .from('notifications')
      .select('is_read')
      .then(result => {
        const stats = { read: 0, unread: 0 };
        result.data.forEach(notification => {
          if (notification.is_read) {
            stats.read++;
          } else {
            stats.unread++;
          }
        });
        return { data: stats };
      });

    // Get recent notifications (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentNotifications } = await supabase
      .from('notifications')
      .select('id')
      .gte('created_at', thirtyDaysAgo.toISOString());

    res.json({
      typeStats,
      readStats,
      recentCount: recentNotifications.length,
      totalCount: Object.values(typeStats).reduce((sum, count) => sum + count, 0)
    });
  } catch (error) {
    console.error('Get notification stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
