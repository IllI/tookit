-- Remove link_ref from events table
ALTER TABLE events 
  DROP COLUMN IF EXISTS link_ref; 