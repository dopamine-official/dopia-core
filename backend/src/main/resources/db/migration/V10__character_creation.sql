-- Members make characters and an operator approves them (CHARACTER 3-2). Until now an operator
-- wrote every row by hand, with `is_public` and a free-text `creator_name`.

-- Characters that already exist belong to one operator account. Production has none; this covers
-- development databases, whose sample rows the dev seed rewrites afterwards.
INSERT INTO accounts (id, is_guest, nickname)
SELECT '00000000-0000-4000-8000-000000000001', false, 'Studio Chat'
WHERE EXISTS (SELECT 1 FROM characters)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE characters
    DROP CONSTRAINT characters_localized_text,
    DROP CONSTRAINT characters_banner_image,
    DROP CONSTRAINT characters_status_window_text,
    DROP CONSTRAINT characters_character_name_text,
    DROP CONSTRAINT characters_gender_check;

ALTER TABLE characters
    ADD COLUMN creator_id            uuid REFERENCES accounts (id),
    ADD COLUMN status                text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
    ADD COLUMN rejection_reason      text,
    ADD COLUMN age                   integer CHECK (age BETWEEN 0 AND 99999),
    ADD COLUMN status_window_initial jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN submitted_at          timestamptz,
    ADD COLUMN approved_at           timestamptz,
    ALTER COLUMN gender DROP NOT NULL,
    ALTER COLUMN image_url DROP NOT NULL,
    ALTER COLUMN name SET DEFAULT '{}',
    ALTER COLUMN tagline SET DEFAULT '{}',
    ALTER COLUMN first_message SET DEFAULT '{}',
    ALTER COLUMN personality SET DEFAULT '{}',
    ALTER COLUMN speech_style SET DEFAULT '{}',
    ALTER COLUMN world_setting SET DEFAULT '{}';

UPDATE characters
SET creator_id       = '00000000-0000-4000-8000-000000000001',
    status           = CASE WHEN is_public THEN 'approved' ELSE 'rejected' END,
    rejection_reason = CASE WHEN is_public THEN NULL ELSE 'not public before the migration' END,
    approved_at      = CASE WHEN is_public THEN updated_at END,
    age              = 20,
    gender           = CASE WHEN gender IN ('female', 'male') THEN gender ELSE 'female' END,
    character_name   = CASE WHEN coalesce(character_name ->> source_locale, '') = '' THEN name ELSE character_name END;

ALTER TABLE characters
    ALTER COLUMN creator_id SET NOT NULL,
    DROP COLUMN is_public,
    DROP COLUMN creator_name;

-- A localized text is a JSON object of locale -> string. Empty is allowed: a draft may have gaps.
CREATE FUNCTION localized_text_object(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS
$$
SELECT jsonb_typeof(value) = 'object'
   AND NOT EXISTS (SELECT 1 FROM jsonb_each(value) AS entry WHERE jsonb_typeof(entry.value) <> 'string')
$$;

-- The text the creator wrote, in the language they wrote it in.
CREATE FUNCTION source_text(value jsonb, source_locale text) RETURNS text
    LANGUAGE sql IMMUTABLE AS
$$
SELECT coalesce(value ->> source_locale, '')
$$;

ALTER TABLE characters
    ADD CONSTRAINT characters_gender CHECK (gender IN ('female', 'male')),
    ADD CONSTRAINT characters_localized_text CHECK (
        localized_text_object(name)
        AND localized_text_object(character_name)
        AND localized_text_object(tagline)
        AND localized_text_object(first_message)
        AND localized_text_object(personality)
        AND localized_text_object(speech_style)
        AND localized_text_object(world_setting)
        AND localized_text_object(status_window_format)
        AND localized_text_object(status_window_initial)
        AND localized_text_object(status_window_rules)
    ),
    -- Everything a submitted character needs. A draft may be incomplete.
    ADD CONSTRAINT characters_complete CHECK (
        status = 'draft'
        OR (
            source_text(name, source_locale) <> ''
            AND source_text(character_name, source_locale) <> ''
            AND source_text(tagline, source_locale) <> ''
            AND source_text(first_message, source_locale) <> ''
            AND source_text(personality, source_locale) <> ''
            AND source_text(speech_style, source_locale) <> ''
            AND source_text(world_setting, source_locale) <> ''
            AND gender IS NOT NULL
            AND age IS NOT NULL
            AND image_url IS NOT NULL
            AND (NOT status_window_enabled OR source_text(status_window_initial, source_locale) <> '')
        )
    ),
    ADD CONSTRAINT characters_text_length CHECK (
        char_length(source_text(name, source_locale)) <= 30
        AND char_length(source_text(character_name, source_locale)) <= 30
        AND char_length(source_text(tagline, source_locale)) <= 35
        AND char_length(source_text(personality, source_locale)) <= 2000
        AND char_length(source_text(speech_style, source_locale)) <= 2000
        AND char_length(source_text(world_setting, source_locale)) <= 6000
        AND char_length(source_text(first_message, source_locale)) <= 3000
        AND char_length(source_text(status_window_format, source_locale)) <= 500
        AND char_length(source_text(status_window_initial, source_locale)) <= 500
        AND char_length(source_text(status_window_rules, source_locale)) <= 1000
    ),
    -- Same number as character.adult_min_age.
    ADD CONSTRAINT characters_adult_age CHECK (NOT is_adult OR (age IS NOT NULL AND age >= 20)),
    ADD CONSTRAINT characters_rejection_reason CHECK (
        (status = 'rejected') = (coalesce(rejection_reason, '') <> '')
    ),
    ADD CONSTRAINT characters_banner_image CHECK (
        NOT is_banner OR (banner_image_url IS NOT NULL AND status = 'approved')
    );

CREATE INDEX characters_mine
    ON characters (creator_id, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX characters_creator_profile
    ON characters (creator_id, approved_at DESC)
    WHERE status = 'approved' AND deleted_at IS NULL;

-- An operator approves and rejects in the console by changing `status` (3-2-4).
CREATE FUNCTION characters_status_changed() RETURNS trigger
    LANGUAGE plpgsql AS
$$
DECLARE
    section uuid;
BEGIN
    IF NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending' THEN
        NEW.submitted_at = now();
        NEW.rejection_reason = NULL;
    END IF;
    IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
        NEW.approved_at = now();
        NEW.rejection_reason = NULL;
        -- First approval: put the character at the front of the last public section.
        IF NOT EXISTS (SELECT 1 FROM home_section_characters WHERE character_id = NEW.id) THEN
            SELECT id INTO section
            FROM home_sections
            WHERE deleted_at IS NULL AND is_public
            ORDER BY position DESC
            LIMIT 1;
            IF section IS NOT NULL THEN
                INSERT INTO home_section_characters (section_id, character_id, position)
                SELECT section, NEW.id, coalesce(min(position) - 1, 0)
                FROM home_section_characters
                WHERE section_id = section;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER characters_status_changed
    BEFORE UPDATE OF status ON characters
    FOR EACH ROW EXECUTE FUNCTION characters_status_changed();

-- Pictures a creator uploads with a name and the situation they belong to (3-2-9).
CREATE TABLE character_images (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (name <> '' AND char_length(name) <= 40),
    description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
    image_url    text NOT NULL,
    position     integer NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT character_images_name UNIQUE (character_id, name)
);

CREATE INDEX character_images_order ON character_images (character_id, position);
