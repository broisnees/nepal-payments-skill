-- The shop takes Khalti as well as eSewa; existing attempts were all eSewa.
ALTER TABLE shop_attempts ADD COLUMN gateway TEXT NOT NULL DEFAULT 'esewa';
