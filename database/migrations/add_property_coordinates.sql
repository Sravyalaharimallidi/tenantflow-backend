-- Add latitude and longitude columns to properties table for location-based search
-- This migration adds coordinate support to properties table

-- Check if columns already exist before adding them
DO $$ 
BEGIN
    -- Add latitude column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'properties' AND column_name = 'latitude') THEN
        ALTER TABLE properties ADD COLUMN latitude DECIMAL(10, 8);
    END IF;
    
    -- Add longitude column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'properties' AND column_name = 'longitude') THEN
        ALTER TABLE properties ADD COLUMN longitude DECIMAL(11, 8);
    END IF;
END $$;

-- Add index for faster location-based queries (only if columns exist)
CREATE INDEX IF NOT EXISTS idx_properties_coordinates 
ON properties(latitude, longitude) 
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Add comment to document the purpose
COMMENT ON COLUMN properties.latitude IS 'Latitude coordinate for location-based search';
COMMENT ON COLUMN properties.longitude IS 'Longitude coordinate for location-based search';