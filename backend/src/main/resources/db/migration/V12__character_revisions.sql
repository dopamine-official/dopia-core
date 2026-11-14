-- An approved character that its creator edits keeps what is public until an operator approves
-- the edit (CHARACTER 3-2-11). The edit waits here; `characters` keeps the public content.

CREATE TABLE character_revisions (
    character_id          uuid PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
    -- 'approved' is what an operator writes to approve; the trigger applies the row and deletes it.
    status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rejected', 'approved')),
    rejection_reason      text,
    source_locale         text NOT NULL,
    name                  jsonb NOT NULL,
    character_name        jsonb NOT NULL,
    tagline               jsonb NOT NULL,
    first_message         jsonb NOT NULL,
    personality           jsonb NOT NULL,
    speech_style          jsonb NOT NULL,
    world_setting         jsonb NOT NULL,
    status_window_enabled boolean NOT NULL,
    status_window_format  jsonb NOT NULL DEFAULT '{}',
    status_window_initial jsonb NOT NULL DEFAULT '{}',
    status_window_rules   jsonb NOT NULL DEFAULT '{}',
    gender                text NOT NULL CHECK (gender IN ('female', 'male')),
    age                   integer NOT NULL CHECK (age BETWEEN 0 AND 99999),
    image_url             text NOT NULL,
    is_adult              boolean NOT NULL,
    submitted_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT character_revisions_localized_text CHECK (
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
    -- A revision is always a submitted one, so it is always complete.
    CONSTRAINT character_revisions_complete CHECK (
        source_text(name, source_locale) <> ''
        AND source_text(character_name, source_locale) <> ''
        AND source_text(tagline, source_locale) <> ''
        AND source_text(first_message, source_locale) <> ''
        AND source_text(personality, source_locale) <> ''
        AND source_text(speech_style, source_locale) <> ''
        AND source_text(world_setting, source_locale) <> ''
        AND (NOT status_window_enabled OR source_text(status_window_initial, source_locale) <> '')
    ),
    CONSTRAINT character_revisions_text_length CHECK (
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
    CONSTRAINT character_revisions_adult_age CHECK (NOT is_adult OR age >= 20),
    CONSTRAINT character_revisions_rejection_reason CHECK (
        (status = 'rejected') = (coalesce(rejection_reason, '') <> '')
    )
);

-- A reason belongs to a rejection only.
CREATE FUNCTION character_revisions_status_changing() RETURNS trigger
    LANGUAGE plpgsql AS
$$
BEGIN
    IF NEW.status <> 'rejected' THEN
        NEW.rejection_reason = NULL;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER character_revisions_status_changing
    BEFORE UPDATE OF status ON character_revisions
    FOR EACH ROW EXECUTE FUNCTION character_revisions_status_changing();

-- Approving a revision: its content replaces what is public, and the revision is gone.
CREATE FUNCTION character_revisions_approved() RETURNS trigger
    LANGUAGE plpgsql AS
$$
BEGIN
    PERFORM 1 FROM characters WHERE id = NEW.character_id AND status = 'approved' AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'character % is not public, its revision cannot be approved', NEW.character_id;
    END IF;
    UPDATE characters
    SET name                  = NEW.name,
        character_name        = NEW.character_name,
        tagline               = NEW.tagline,
        first_message         = NEW.first_message,
        personality           = NEW.personality,
        speech_style          = NEW.speech_style,
        world_setting         = NEW.world_setting,
        status_window_enabled = NEW.status_window_enabled,
        status_window_format  = NEW.status_window_format,
        status_window_initial = NEW.status_window_initial,
        status_window_rules   = NEW.status_window_rules,
        gender                = NEW.gender,
        age                   = NEW.age,
        image_url             = NEW.image_url,
        is_adult              = NEW.is_adult
    WHERE id = NEW.character_id;
    DELETE FROM character_revisions WHERE character_id = NEW.character_id;
    RETURN NULL;
END
$$;

CREATE TRIGGER character_revisions_approved
    AFTER UPDATE OF status ON character_revisions
    FOR EACH ROW WHEN (NEW.status = 'approved')
    EXECUTE FUNCTION character_revisions_approved();

-- A revision exists for a public character only: taking the character down drops it.
CREATE OR REPLACE FUNCTION characters_status_changed() RETURNS trigger
    LANGUAGE plpgsql AS
$$
DECLARE
    section uuid;
BEGIN
    IF OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
        DELETE FROM character_revisions WHERE character_id = NEW.id;
    END IF;
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

-- Everything waiting for a review, oldest first: first submissions ('new') and revisions ('edit').
CREATE VIEW character_review_queue AS
SELECT id AS character_id, 'new' AS kind, submitted_at, creator_id, source_locale,
       name, character_name, tagline, first_message, personality, speech_style, world_setting,
       status_window_enabled, status_window_format, status_window_initial, status_window_rules,
       gender, age, image_url, is_adult
FROM characters
WHERE status = 'pending' AND deleted_at IS NULL
UNION ALL
SELECT r.character_id, 'edit', r.submitted_at, c.creator_id, r.source_locale,
       r.name, r.character_name, r.tagline, r.first_message, r.personality, r.speech_style, r.world_setting,
       r.status_window_enabled, r.status_window_format, r.status_window_initial, r.status_window_rules,
       r.gender, r.age, r.image_url, r.is_adult
FROM character_revisions r
JOIN characters c ON c.id = r.character_id
WHERE r.status = 'pending'
ORDER BY submitted_at;

-- The two operator actions. Both lock the character row first, as a creator's submit does.
CREATE FUNCTION approve_character(target uuid) RETURNS void
    LANGUAGE plpgsql AS
$$
DECLARE
    current_status text;
BEGIN
    SELECT status INTO current_status FROM characters WHERE id = target AND deleted_at IS NULL FOR UPDATE;
    IF EXISTS (SELECT 1 FROM character_revisions WHERE character_id = target AND status = 'pending') THEN
        UPDATE character_revisions SET status = 'approved' WHERE character_id = target;
    ELSIF current_status = 'pending' THEN
        UPDATE characters SET status = 'approved' WHERE id = target;
    ELSE
        RAISE EXCEPTION 'character % has nothing waiting for a review', target;
    END IF;
END
$$;

CREATE FUNCTION reject_character(target uuid, reason text) RETURNS void
    LANGUAGE plpgsql AS
$$
DECLARE
    current_status text;
BEGIN
    SELECT status INTO current_status FROM characters WHERE id = target AND deleted_at IS NULL FOR UPDATE;
    IF EXISTS (SELECT 1 FROM character_revisions WHERE character_id = target AND status = 'pending') THEN
        UPDATE character_revisions SET status = 'rejected', rejection_reason = reason WHERE character_id = target;
    ELSIF current_status = 'pending' THEN
        UPDATE characters SET status = 'rejected', rejection_reason = reason WHERE id = target;
    ELSE
        RAISE EXCEPTION 'character % has nothing waiting for a review', target;
    END IF;
END
$$;
