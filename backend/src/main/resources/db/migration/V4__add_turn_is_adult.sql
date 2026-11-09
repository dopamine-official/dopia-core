-- Step 1 of renaming chat_turns.adult_mode to is_adult without breaking running or rolled-back instances.
-- New code writes is_adult only. Old code still writes adult_mode, so both stay nullable for now.
-- Step 2 (next release): backfill is_adult from adult_mode, set it NOT NULL, drop adult_mode.
ALTER TABLE chat_turns ADD COLUMN is_adult boolean;
UPDATE chat_turns SET is_adult = adult_mode;
ALTER TABLE chat_turns ALTER COLUMN adult_mode DROP NOT NULL;
