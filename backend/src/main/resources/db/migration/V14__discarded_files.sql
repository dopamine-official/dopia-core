-- An operator approves in the console, so the server is not there to delete the picture that an
-- approved edit replaces. The database notes the file here and the server deletes it later
-- (CHARACTER 3-2-12).

CREATE TABLE discarded_files (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    url        text NOT NULL CHECK (url <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discarded_files ENABLE ROW LEVEL SECURITY;

-- Approving a revision: its content replaces what is public, and the revision is gone.
CREATE OR REPLACE FUNCTION character_revisions_approved() RETURNS trigger
    LANGUAGE plpgsql AS
$$
DECLARE
    public_image text;
BEGIN
    SELECT image_url INTO public_image
    FROM characters
    WHERE id = NEW.character_id AND status = 'approved' AND deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'character % is not public, its revision cannot be approved', NEW.character_id;
    END IF;
    -- The thumbnail the edit replaces: nothing shows it from now on.
    IF public_image IS DISTINCT FROM NEW.image_url AND coalesce(public_image, '') <> '' THEN
        INSERT INTO discarded_files (url) VALUES (public_image);
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

-- A revision exists for a public character only: taking the character down drops it, and the
-- thumbnail only the revision used goes with it.
CREATE OR REPLACE FUNCTION characters_status_changed() RETURNS trigger
    LANGUAGE plpgsql AS
$$
DECLARE
    section uuid;
BEGIN
    IF OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved' THEN
        INSERT INTO discarded_files (url)
        SELECT image_url FROM character_revisions
        WHERE character_id = NEW.id AND image_url IS DISTINCT FROM OLD.image_url;
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
