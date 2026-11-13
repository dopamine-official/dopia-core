-- The name the character goes by in the story, sent to the AI (CHARACTER 3-2-3). `name` is what the
-- card shows and may read like a title, so the two are separate. Empty for characters made before
-- this column: chat falls back to `name`.
ALTER TABLE characters
    ADD COLUMN character_name jsonb NOT NULL DEFAULT '{}';

ALTER TABLE characters
    ADD CONSTRAINT characters_character_name_text CHECK (
        jsonb_typeof(character_name) = 'object'
        AND NOT jsonb_path_exists(character_name, '$.* ? (@.type() != "string")')
    );
