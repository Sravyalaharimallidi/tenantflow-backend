const express = require('express');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { supabase } = require('../config/supabase');
const { authenticateToken, requireOwnerVerification, logActivity } = require('../middleware/auth');

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
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and GIF images are allowed.'));
    }
  }
});

// Get all properties for a specific owner
router.get('/my-properties', authenticateToken, requireOwnerVerification, async (req, res) => {
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

    // Get properties with rooms
    const { data: properties, error } = await supabase
      .from('properties')
      .select(`
        *,
        rooms(id, room_number, room_type, rent_amount, status, last_updated)
      `)
      .eq('owner_id', owner.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch properties' });
    }

    res.json({ properties });
  } catch (error) {
    console.error('Get properties error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add new property
router.post('/add-property', authenticateToken, [
  body('name').trim().isLength({ min: 2 }),
  body('address').trim().isLength({ min: 10 }),
  body('city').trim().isLength({ min: 2 }),
  body('state').trim().isLength({ min: 2 }),
  body('pincode').isLength({ min: 6, max: 6 }).isNumeric(),
  body('description').optional().trim(),
  body('latitude').optional().isFloat({ min: -90, max: 90 }),
  body('longitude').optional().isFloat({ min: -180, max: 180 }),
  body('amenities').optional().isArray()
], async (req, res) => {
  try {
  // Request body and user info intentionally not logged to avoid leaking sensitive data
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Property validation errors:', errors.array());
      return res.status(400).json({ 
        error: 'Validation failed',
        details: errors.array() 
      });
    }

    // Get owner ID
    const { data: owner } = await supabase
      .from('owners')
      .select('id')
      .eq('user_id', req.user.id)
      .single();

    if (!owner) {
      return res.status(404).json({ error: 'Owner profile not found' });
    }

    // Check if owner is verified
    if (req.user.verification_status !== 'approved') {
      return res.status(403).json({ 
        error: 'Owner account not verified',
        details: 'Please wait for admin approval before adding properties'
      });
    }

    const { name, address, city, state, pincode, description, latitude, longitude, amenities } = req.body;

    // Create property
    const propertyData = {
      owner_id: owner.id,
      name,
      address,
      city,
      state,
      pincode,
      description,
      amenities: amenities || []
    };

    // TODO: Add coordinates support after database migration
    // For now, skip coordinates to avoid database errors
    // if (latitude && longitude && latitude.trim() !== '' && longitude.trim() !== '') {
    //   propertyData.latitude = parseFloat(latitude);
    //   propertyData.longitude = parseFloat(longitude);
    // }

  // Inserting property data (sensitive) - not logging details
    
    const { data: property, error } = await supabase
      .from('properties')
      .insert(propertyData)
      .select()
      .single();

    if (error) {
      console.error('Database error creating property:', error);
      return res.status(500).json({ 
        error: 'Failed to create property',
        details: error.message 
      });
    }

    // Log activity
    await logActivity(req.user.id, 'create', 'properties', property.id, null, property, req);

    res.status(201).json({
      message: 'Property created successfully',
      property
    });
  } catch (error) {
    console.error('Add property error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update property details
router.put('/update-property/:propertyId', authenticateToken, requireOwnerVerification, [
  body('name').optional().trim().isLength({ min: 2 }),
  body('address').optional().trim().isLength({ min: 10 }),
  body('city').optional().trim().isLength({ min: 2 }),
  body('state').optional().trim().isLength({ min: 2 }),
  body('pincode').optional().isPostalCode('IN'),
  body('description').optional().trim(),
  body('amenities').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { propertyId } = req.params;

    // Verify ownership
    const { data: property, error: fetchError } = await supabase
      .from('properties')
      .select(`
        *,
        owners!inner(user_id)
      `)
      .eq('id', propertyId)
      .eq('owners.user_id', req.user.id)
      .single();

    if (fetchError || !property) {
      return res.status(404).json({ error: 'Property not found or access denied' });
    }

    const updateData = {};
    const allowedFields = ['name', 'address', 'city', 'state', 'pincode', 'description', 'amenities'];
    
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Update property
    const { data: updatedProperty, error } = await supabase
      .from('properties')
      .update(updateData)
      .eq('id', propertyId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update property' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'properties', propertyId, property, updatedProperty, req);

    res.json({
      message: 'Property updated successfully',
      property: updatedProperty
    });
  } catch (error) {
    console.error('Update property error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add room to property
router.post('/add-room/:propertyId', authenticateToken, requireOwnerVerification, [
  body('roomNumber').trim().isLength({ min: 1 }),
  body('roomType').trim().isLength({ min: 2 }),
  body('rentAmount').isDecimal({ decimal_digits: '0,2' }),
  body('depositAmount').optional().isDecimal({ decimal_digits: '0,2' }),
  body('amenities').optional().isArray(),
  body('latitude').optional().isFloat({ min: -90, max: 90 }),
  body('longitude').optional().isFloat({ min: -180, max: 180 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Add Room - Validation errors:', errors.array());
      return res.status(400).json({ error: 'Validation failed', errors: errors.array() });
    }
    const { propertyId } = req.params;
    let { roomNumber, roomType, rentAmount, depositAmount, amenities, latitude, longitude } = req.body;

    // Defensive: ensure correct types
    roomNumber = typeof roomNumber === 'string' ? roomNumber : '';
    roomType = typeof roomType === 'string' ? roomType : '';
    rentAmount = typeof rentAmount === 'string' ? rentAmount : rentAmount.toString();
    if (!depositAmount) depositAmount = '0';
    depositAmount = typeof depositAmount === 'string' ? depositAmount : depositAmount.toString();
    amenities = Array.isArray(amenities) ? amenities :
      (typeof amenities === 'string' && amenities.trim() !== '' ? amenities.split(',').map(x => x.trim()) : []);
    if (latitude && typeof latitude === 'string') latitude = parseFloat(latitude);
    if (longitude && typeof longitude === 'string') longitude = parseFloat(longitude);

    // Verify ownership
    const { data: property, error: fetchError } = await supabase
      .from('properties')
      .select(`*, owners!inner(user_id)`) // check ownership
      .eq('id', propertyId)
      .eq('owners.user_id', req.user.id)
      .single();
    if (fetchError || !property) {
      return res.status(404).json({ error: 'Property not found or access denied' });
    }
    // Check if room number already exists in this property
    const { data: existingRoom } = await supabase
      .from('rooms')
      .select('id')
      .eq('property_id', propertyId)
      .eq('room_number', roomNumber)
      .single();
    if (existingRoom) {
      return res.status(400).json({ error: 'Room number already exists in this property' });
    }
    // Create room
    const roomData = {
      property_id: propertyId,
      room_number: roomNumber,
      room_type: roomType,
      rent_amount: parseFloat(rentAmount),
      deposit_amount: depositAmount ? parseFloat(depositAmount) : 0,
      amenities: amenities || [],
      status: 'available',
    };
    if (latitude && longitude) {
      roomData.latitude = latitude;
      roomData.longitude = longitude;
    }
    const { data: room, error } = await supabase
      .from('rooms')
      .insert(roomData)
      .select()
      .single();
    if (error) {
      console.error('Database error creating room:', error);
      return res.status(500).json({ error: 'Failed to create room', details: error.message });
    }
    await logActivity(req.user.id, 'create', 'rooms', room.id, null, room, req);
    res.status(201).json({ message: 'Room added successfully', room });
  } catch (error) {
    console.error('Add room error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update room availability status
router.put('/update-room-status/:roomId', authenticateToken, requireOwnerVerification, [
  body('status').isIn(['available', 'occupied', 'reserved', 'maintenance'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { roomId } = req.params;
    const { status } = req.body;

    // Verify ownership through property
    const { data: room, error: fetchError } = await supabase
      .from('rooms')
      .select(`
        *,
        properties!inner(
          owners!inner(user_id)
        )
      `)
      .eq('id', roomId)
      .eq('properties.owners.user_id', req.user.id)
      .single();

    if (fetchError || !room) {
      return res.status(404).json({ error: 'Room not found or access denied' });
    }

    // Check if room is already booked when trying to mark as available
    if (status === 'available') {
      const { data: activeBooking } = await supabase
        .from('bookings')
        .select('id')
        .eq('room_id', roomId)
        .in('status', ['pending', 'approved'])
        .single();

      if (activeBooking) {
        return res.status(400).json({ error: 'Cannot mark room as available while it has active bookings' });
      }
    }

    // Update room status
    const { data: updatedRoom, error } = await supabase
      .from('rooms')
      .update({ 
        status,
        last_updated: new Date().toISOString()
      })
      .eq('id', roomId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update room status' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'rooms', roomId, { status: room.status }, { status }, req);

    res.json({
      message: 'Room status updated successfully',
      room: updatedRoom
    });
  } catch (error) {
    console.error('Update room status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload property images
router.post('/upload-images/:propertyId', authenticateToken, requireOwnerVerification, upload.array('images', 10), async (req, res) => {
  try {
    const { propertyId } = req.params;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    // Verify ownership
    const { data: property, error: fetchError } = await supabase
      .from('properties')
      .select(`
        *,
        owners!inner(user_id)
      `)
      .eq('id', propertyId)
      .eq('owners.user_id', req.user.id)
      .single();

    if (fetchError || !property) {
      return res.status(404).json({ error: 'Property not found or access denied' });
    }

    // Get existing images
    const existingImages = property.images || [];

    // Process uploaded files
    const newImages = req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      path: file.path,
      size: file.size,
      uploadedAt: new Date().toISOString()
    }));

    // Combine existing and new images
    const allImages = [...existingImages, ...newImages];

    // Update property with new images
    const { data: updatedProperty, error } = await supabase
      .from('properties')
      .update({ images: allImages })
      .eq('id', propertyId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update property images' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'properties', propertyId, { images: existingImages }, { images: allImages }, req);

    res.json({
      message: 'Images uploaded successfully',
      images: newImages,
      totalImages: allImages.length
    });
  } catch (error) {
    console.error('Upload images error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all available rooms for tenants to search
router.get('/available-rooms', async (req, res) => {
  try {
    const { location, maxRent, minRent, roomType, latitude, longitude, radius, sortBy, sortOrder } = req.query;
    // Build base query
    let query = supabase
      .from('rooms')
      .select(`
        *,
        properties!inner(
          id, name, address, city, state, pincode, amenities, images,
          owners!inner(name, phone, business_name)
        )
      `)
      .eq('status', 'available');

    // Filters
    if (location) {
      // Treat location as city or area; use ilike on city and state and address
      query = query.or(`properties.city.ilike.%${location}%,properties.state.ilike.%${location}%,properties.address.ilike.%${location}%`);
    }
    if (minRent) {
      query = query.gte('rent_amount', parseFloat(minRent));
    }
    if (maxRent) {
      query = query.lte('rent_amount', parseFloat(maxRent));
    }
    if (roomType) {
      query = query.eq('room_type', roomType);
    }

    // Sorting logic: map frontend sort keys to DB columns
    let orderColumn = 'created_at';
    let ascending = false; // default newest first
    if (sortBy) {
      if (sortBy === 'rent') orderColumn = 'rent_amount';
      else if (sortBy === 'deposit') orderColumn = 'deposit_amount';
      else if (sortBy === 'created') orderColumn = 'created_at';
    }
    if (sortOrder) {
      ascending = sortOrder === 'asc';
    }

    // If latitude/longitude provided, compute distance on the application side
    let roomsData;
    if (latitude && longitude) {
      const lat = parseFloat(latitude);
      const lon = parseFloat(longitude);
      const radKm = radius ? parseFloat(radius) : 10;

      // Fetch candidate rooms (apply rent/roomType/location filters first)
      const { data: candidates, error: fetchErr } = await query;
      if (fetchErr) {
        console.error('Error fetching candidate rooms:', fetchErr);
        return res.status(500).json({ error: 'Failed to fetch available rooms' });
      }

      // Haversine distance function
      const toRad = (v) => (v * Math.PI) / 180;
      const distanceKm = (lat1, lon1, lat2, lon2) => {
        if (lat2 == null || lon2 == null) return null;
        const R = 6371; // Earth radius km
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      };

      roomsData = (candidates || []).map(r => {
        const prop = r.properties || {};
        const d = distanceKm(lat, lon, r.latitude || prop.latitude, r.longitude || prop.longitude);
        return { ...r, distance_km: d };
      }).filter(r => r.distance_km === null || r.distance_km <= radKm);

      // sort by requested column or by distance if sorting by distance
      if (sortBy === 'distance') {
        roomsData.sort((a, b) => (a.distance_km || Infinity) - (b.distance_km || Infinity));
      } else {
        roomsData.sort((a, b) => {
          const av = a[orderColumn] ?? (a[orderColumn] === 0 ? 0 : null);
          const bv = b[orderColumn] ?? (b[orderColumn] === 0 ? 0 : null);
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return ascending ? av - bv : bv - av;
        });
      }

      // send search center info
      return res.json({ rooms: roomsData, search_center: { latitude: lat, longitude: lon }, search_radius: radKm });
    }

    // No geo filters: use database-side ordering/pagination
    const { data: rooms, error } = await query.order(orderColumn, { ascending });
    if (error) {
      console.error('Failed to fetch available rooms:', error);
      return res.status(500).json({ error: 'Failed to fetch available rooms' });
    }

    res.json({ rooms });
  } catch (error) {
    console.error('Get available rooms error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update room coordinates
router.put('/update-room-coordinates/:roomId', authenticateToken, requireOwnerVerification, [
  body('latitude').isFloat({ min: -90, max: 90 }),
  body('longitude').isFloat({ min: -180, max: 180 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { roomId } = req.params;
    const { latitude, longitude } = req.body;

    // Verify ownership through property
    const { data: room, error: fetchError } = await supabase
      .from('rooms')
      .select(`
        *,
        properties!inner(
          owners!inner(user_id)
        )
      `)
      .eq('id', roomId)
      .eq('properties.owners.user_id', req.user.id)
      .single();

    if (fetchError || !room) {
      return res.status(404).json({ error: 'Room not found or access denied' });
    }

    // Update room coordinates
    const { data: updatedRoom, error } = await supabase
      .from('rooms')
      .update({ 
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        updated_at: new Date().toISOString()
      })
      .eq('id', roomId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update room coordinates' });
    }

    // Log activity
    await logActivity(req.user.id, 'update', 'rooms', roomId, 
      { latitude: room.latitude, longitude: room.longitude }, 
      { latitude, longitude }, req);

    res.json({
      message: 'Room coordinates updated successfully',
      room: updatedRoom
    });
  } catch (error) {
    console.error('Update room coordinates error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
