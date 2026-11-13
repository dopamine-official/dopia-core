-- Optional status window per character (CHARACTER 3-2-3). The creator turns it on per character;
-- while it is off the format and rules are kept but never reach the prompt.
ALTER TABLE characters
    ADD COLUMN status_window_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN status_window_format  jsonb   NOT NULL DEFAULT '{}',
    ADD COLUMN status_window_rules   jsonb   NOT NULL DEFAULT '{}';

ALTER TABLE characters
    ADD CONSTRAINT characters_status_window_text CHECK (
        jsonb_typeof(status_window_format) = 'object'
        AND NOT jsonb_path_exists(status_window_format, '$.* ? (@.type() != "string")')
        AND jsonb_typeof(status_window_rules) = 'object'
        AND NOT jsonb_path_exists(status_window_rules, '$.* ? (@.type() != "string")')
    ),
    -- Turned on means there is a format to show, in the language the character was written in.
    ADD CONSTRAINT characters_status_window_format CHECK (
        NOT status_window_enabled OR coalesce(status_window_format ->> source_locale, '') <> ''
    );
