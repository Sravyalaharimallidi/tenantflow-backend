const express = require('express');
const { body, validationResult } = require('express-validator');
const { supabase } = require('../config/supabase');
const { authenticateToken, authorizeRole, logActivity } = require('../middleware/auth');

const router = express.Router();

// Book a room (Tenant)
router.post('/book-room', authenticateToken, authorizeRole(['tenant']), async (req, res) => {
  try {
    // Accept both camelCase and snake_case payloads
    let { roomId, moveInDate, moveOutDate, notes } = req.body || {};
    if (!roomId && req.body.room_id) roomId = req.body.room_id;
    if (!moveInDate && req.body.move_in_date) moveInDate = req.body.move_in_date;
    if (!moveOutDate && req.body.move_out_date) moveOutDate = req.body.move_out_date;
    if (!notes && req.body.tenant_notes) notes = req.body.tenant_notes;

    // Basic validation with clear messages
    const errors = [];
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    if (!roomId || !uuidRegex.test(String(roomId))) {
      errors.push({ param: 'roomId', msg: 'roomId is required and must be a UUID' });
    }
    // moveInDate is required; accept ISO date or YYYY-MM-DD
    let parsedMoveIn = null;
    if (!moveInDate) {
      errors.push({ param: 'moveInDate', msg: 'moveInDate is required' });
    } else {
      // try parsing
      parsedMoveIn = new Date(moveInDate);
      if (isNaN(parsedMoveIn.getTime())) {
        errors.push({ param: 'moveInDate', msg: 'moveInDate must be a valid date (ISO8601 or YYYY-MM-DD)' });
      }
    }
    let parsedMoveOut = null;
    if (moveOutDate) {
      parsedMoveOut = new Date(moveOutDate);
      if (isNaN(parsedMoveOut.getTime())) {
        errors.push({ param: 'moveOutDate', msg: 'moveOutDate must be a valid date (ISO8601 or YYYY-MM-DD)' });
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    // normalize values for insertion
    const normalizedMoveIn = parsedMoveIn ? parsedMoveIn.toISOString() : null;
    const normalizedMoveOut = parsedMoveOut ? parsedMoveOut.toISOString() : null;

    // now use normalized variables going forward

    // Get tenant details
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select('id, name, phone, room_number')
      .eq('user_id', req.user.id)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant profile not found' });
    }

    // Check if tenant already has an active booking
    const { data: existingBooking } = await supabase
      .from('bookings')
      .select('id')
      .eq('tenant_id', tenant.id)
      .in('status', ['pending', 'approved'])
      .single();

    if (existingBooking) {
      return res.status(400).json({ error: 'You already have an active booking' });
    }

    // Verify room is available
    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select(`
        *,
        properties!inner(
          id, name, address,
          owners!inner(id, user_id, name, phone)
        )
      `)
      .eq('id', roomId)
      .eq('status', 'available')
      .single();

    if (roomError || !room) {
      return res.status(400).json({ error: 'Room not available for booking' });
    }

    // Create booking
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        tenant_id: tenant.id,
        room_id: roomId,
        property_id: room.properties.id,
        move_in_date: normalizedMoveIn,
        move_out_date: normalizedMoveOut,
        status: 'pending',
        tenant_notes: notes
      })
      .select()
      .single();

    if (bookingError) {
      return res.status(500).json({ error: 'Failed to create booking request' });
    }

    // Update room status to reserved
    await supabase
      .from('rooms')
      .update({ 
        status: 'reserved',
        last_updated: new Date().toISOString()
      })
      .eq('id', roomId);

    // Create notification for owner
    await supabase
      .from('notifications')
      .insert({
        user_id: room.properties.owners.user_id,
        title: 'New Booking Request',
        message: `New booking request from ${tenant.name} for room ${room.room_number}`,
        type: 'booking'
      });

    // Log activity
    await logActivity(req.user.id, 'create', 'bookings', booking.id, null, booking, req);

    res.status(201).json({
      message: 'Booking request submitted successfully',
      booking: {
        ...booking,
        room: {
          room_number: room.room_number,
          room_type: room.room_type,
          rent_amount: room.rent_amount
        },
        property: {
          name: room.properties.name,
          address: room.properties.address
        }
      }
    });
  } catch (error) {
    console.error('Book room error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get tenant's bookings
router.get('/my-bookings', authenticateToken, authorizeRole(['tenant']), async (req, res) => {
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

    // Get bookings with room and property details
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        *,
        rooms(room_number, room_type, rent_amount),
        properties(name, address, city)
      `)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch bookings' });
    }

    res.json({ bookings });
  } catch (error) {
    console.error('Get tenant bookings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get owner's booking requests
router.get('/owner-bookings', authenticateToken, authorizeRole(['owner']), async (req, res) => {
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

    // Get bookings for owner's properties
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        *,
        tenants(name, phone, emergency_contact),
        rooms(room_number, room_type, rent_amount),
        properties(name, address)
      `)
      .eq('properties.owner_id', owner.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch booking requests' });
    }

    res.json({ bookings });
  } catch (error) {
    console.error('Get owner bookings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve/Reject booking (Owner)
router.put('/booking/:bookingId/status', authenticateToken, authorizeRole(['owner']), [
  body('status').isIn(['approved', 'rejected']),
  body('notes').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { bookingId } = req.params;
    const { status, notes } = req.body;

    // Get owner ID
    const { data: owner } = await supabase
      .from('owners')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (!owner) {
      return res.status(404).json({ error: 'Owner profile not found' });
    }

    // Get booking with verification
    const { data: booking, error: fetchError } = await supabase
      .from('bookings')
      .select(`
        *,
        tenants!inner(name, phone, user_id),
        rooms!inner(room_number, room_type),
        properties!inner(owner_id)
      `)
      .eq('id', bookingId)
      .eq('properties.owner_id', owner.id)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Booking not found or access denied' });
    }

    if (booking.status !== 'pending') {
      return res.status(400).json({ error: 'Booking has already been processed' });
    }

    // Update booking status
    const { data: updatedBooking, error } = await supabase
      .from('bookings')
      .update({
        status,
        owner_notes: notes,
        updated_at: new Date().toISOString()
      })
      .eq('id', bookingId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update booking status' });
    }

    // Update room status based on approval
    if (status === 'approved') {
      await supabase
        .from('rooms')
        .update({ 
          status: 'occupied',
          last_updated: new Date().toISOString()
        })
        .eq('id', booking.room_id);

      // Update tenant's room number
      await supabase
        .from('tenants')
        .update({ room_number: booking.rooms.room_number })
        .eq('id', booking.tenant_id);
    } else {
      // Rejected - make room available again
      await supabase
        .from('rooms')
        .update({ 
          status: 'available',
          last_updated: new Date().toISOString()
        })
        .eq('id', booking.room_id);
    }

    // Create notification for tenant
    await supabase
      .from('notifications')
      .insert({
        user_id: booking.tenants.user_id,
        title: `Booking ${status === 'approved' ? 'Approved' : 'Rejected'}`,
        message: `Your booking request for room ${booking.rooms.room_number} has been ${status === 'approved' ? 'approved' : 'rejected'}.`,
        type: 'booking'
      });

    // Log activity
    await logActivity(req.user.id, 'update', 'bookings', bookingId, { status: booking.status }, { status }, req);

    res.json({
      message: `Booking ${status} successfully`,
      booking: updatedBooking
    });
  } catch (error) {
    console.error('Update booking status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel booking (Tenant)
router.put('/booking/:bookingId/cancel', authenticateToken, authorizeRole(['tenant']), async (req, res) => {
  try {
    const { bookingId } = req.params;

    // Get tenant ID
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant profile not found' });
    }

    // Get booking
    const { data: booking, error: fetchError } = await supabase
      .from('bookings')
      .select(`
        *,
        rooms!inner(room_number, room_type),
        properties!inner(name, owner_id)
      `)
      .eq('id', bookingId)
      .eq('tenant_id', tenant.id)
      .single();

    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Booking not found or access denied' });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Booking is already cancelled' });
    }

    // Update booking status
    const { data: updatedBooking, error } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', bookingId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to cancel booking' });
    }

    // Make room available again
    await supabase
      .from('rooms')
      .update({ 
        status: 'available',
        last_updated: new Date().toISOString()
      })
      .eq('id', booking.room_id);

    // Create notification for owner
    await supabase
      .from('notifications')
      .insert({
        user_id: booking.properties.owner_id,
        title: 'Booking Cancelled',
        message: `Booking for room ${booking.rooms.room_number} has been cancelled.`,
        type: 'booking'
      });

    // Log activity
    await logActivity(req.user.id, 'update', 'bookings', bookingId, { status: booking.status }, { status: 'cancelled' }, req);

    res.json({
      message: 'Booking cancelled successfully',
      booking: updatedBooking
    });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all bookings (Admin)
router.get('/all-bookings', authenticateToken, authorizeRole(['admin']), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('bookings')
      .select(`
        *,
        tenants(name, phone),
        rooms(room_number, room_type, rent_amount),
        properties(name, address, city),
        owners(name, business_name)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: bookings, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch bookings' });
    }

    // Get total count
    const { count } = await supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true });

    res.json({
      bookings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Get all bookings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
