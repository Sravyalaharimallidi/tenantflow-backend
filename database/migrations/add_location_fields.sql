-- Migration script to add latitude and longitude fields to rooms table
-- Run this script if you have an existing database

-- Add latitude and longitude columns to rooms table
ALTER TABLE rooms 
ADD COLUMN latitude DECIMAL(10, 8),
ADD COLUMN longitude DECIMAL(11, 8);

-- Add comments for the new columns
COMMENT ON COLUMN rooms.latitude IS 'Latitude coordinate for location-based search';
COMMENT ON COLUMN rooms.longitude IS 'Longitude coordinate for location-based search';

-- Create spatial indexes for better performance
CREATE INDEX idx_rooms_location ON rooms(latitude, longitude);

-- Enable PostGIS extension for spatial operations (if not already enabled)
-- CREATE EXTENSION IF NOT EXISTS postgis;

-- Create spatial index using PostGIS (uncomment if PostGIS is available)
-- CREATE INDEX idx_rooms_coordinates ON rooms USING GIST (ST_Point(longitude, latitude));

-- Alternative spatial index using earthdistance extension
-- CREATE EXTENSION IF NOT EXISTS cube;
-- CREATE EXTENSION IF NOT EXISTS earthdistance;
-- CREATE INDEX idx_rooms_coordinates ON rooms USING GIST (ll_to_earth(latitude, longitude));

-- Update existing rooms with sample coordinates (replace with actual coordinates)
-- UPDATE rooms SET 
--   latitude = 12.9716 + (RANDOM() - 0.5) * 0.1,  -- Bangalore area with some variation
--   longitude = 77.5946 + (RANDOM() - 0.5) * 0.1
-- WHERE latitude IS NULL OR longitude IS NULL;

-- Add a function to calculate distance between two points
CREATE OR REPLACE FUNCTION calculate_distance(
    lat1 DECIMAL, lon1 DECIMAL,
    lat2 DECIMAL, lon2 DECIMAL
) RETURNS DECIMAL AS $$
DECLARE
    earth_radius DECIMAL := 6371; -- Earth's radius in kilometers
    dlat DECIMAL;
    dlon DECIMAL;
    a DECIMAL;
    c DECIMAL;
BEGIN
    -- Convert degrees to radians
    dlat := RADIANS(lat2 - lat1);
    dlon := RADIANS(lon2 - lon1);
    
    -- Haversine formula
    a := SIN(dlat/2) * SIN(dlat/2) + 
         COS(RADIANS(lat1)) * COS(RADIANS(lat2)) * 
         SIN(dlon/2) * SIN(dlon/2);
    
    c := 2 * ATAN2(SQRT(a), SQRT(1-a));
    
    RETURN earth_radius * c;
END;
$$ LANGUAGE plpgsql;

-- Add a function to find rooms within a certain radius
CREATE OR REPLACE FUNCTION find_rooms_within_radius(
    center_lat DECIMAL,
    center_lon DECIMAL,
    radius_km DECIMAL DEFAULT 10
) RETURNS TABLE (
    room_id UUID,
    distance_km DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.id,
        calculate_distance(center_lat, center_lon, r.latitude, r.longitude) as distance_km
    FROM rooms r
    WHERE r.latitude IS NOT NULL 
      AND r.longitude IS NOT NULL
      AND r.status = 'available'
      AND calculate_distance(center_lat, center_lon, r.latitude, r.longitude) <= radius_km
    ORDER BY distance_km;
END;
$$ LANGUAGE plpgsql;
