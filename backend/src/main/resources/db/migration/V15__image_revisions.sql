-- The creator of a public character may change its situation images, and others keep seeing the
-- public ones until an operator approves the change (CHARACTER 3-2-9, 3-2-11). The first change
-- copies the images as they are: the copies are what is public, the creator edits the originals.

ALTER TABLE characters ADD COLUMN has_image_revision boolean NOT NULL DEFAULT false;

ALTER TABLE character_images ADD COLUMN public_copy boolean NOT NULL DEFAULT false;

-- A name is taken once among the copies and once among the images being edited.
ALTER TABLE character_images DROP CONSTRAINT character_images_name;
ALTER TABLE character_images ADD CONSTRAINT character_images_name UNIQUE (character_id, public_copy, name);

DROP INDEX character_images_order;
CREATE INDEX character_images_order ON character_images (character_id, public_copy, position);

-- Drops the images a creator changed while the character was public and makes the copies the
-- character's images again. Returns the files only the dropped images used, for the caller to
-- delete. The caller clears `has_image_revision`.
CREATE FUNCTION restore_public_images(target uuid) RETURNS SETOF text
    LANGUAGE plpgsql AS
$$
BEGIN
    RETURN QUERY
        WITH gone AS (
            DELETE FROM character_images WHERE character_id = target AND NOT public_copy RETURNING image_url
        )
        SELECT g.image_url
        FROM gone g
        WHERE NOT EXISTS (
            SELECT 1 FROM character_images c
            WHERE c.character_id = target AND c.public_copy AND c.image_url = g.image_url
        );
    UPDATE character_images SET public_copy = false WHERE character_id = target AND public_copy;
END
$$;

-- Approving a revision: its content replaces what is public, the changed images become the
-- public ones, and the revision is gone.
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
    -- The copies were what others saw until now. Their files stay: replies in rooms that exist
    -- show those pictures by address.
    DELETE FROM character_images WHERE character_id = NEW.character_id AND public_copy;
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
        is_adult              = NEW.is_adult,
        has_image_revision    = false
    WHERE id = NEW.character_id;
    DELETE FROM character_revisions WHERE character_id = NEW.character_id;
    RETURN NULL;
END
$$;

-- A revision exists for a public character only: taking the character down drops it, with the
-- thumbnail only the revision used and the images changed while it was public.
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
        IF OLD.has_image_revision THEN
            INSERT INTO discarded_files (url) SELECT restore_public_images(NEW.id);
            NEW.has_image_revision = false;
        END IF;
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

-- The queue also says whether the images wait for the review: when `has_image_revision` is true,
-- the rows of `character_images` that are not copies are the ones to look at.
CREATE OR REPLACE VIEW character_review_queue AS
SELECT id AS character_id, 'new' AS kind, submitted_at, creator_id, source_locale,
       name, character_name, tagline, first_message, personality, speech_style, world_setting,
       status_window_enabled, status_window_format, status_window_initial, status_window_rules,
       gender, age, image_url, is_adult, has_image_revision
FROM characters
WHERE status = 'pending' AND deleted_at IS NULL
UNION ALL
SELECT r.character_id, 'edit', r.submitted_at, c.creator_id, r.source_locale,
       r.name, r.character_name, r.tagline, r.first_message, r.personality, r.speech_style, r.world_setting,
       r.status_window_enabled, r.status_window_format, r.status_window_initial, r.status_window_rules,
       r.gender, r.age, r.image_url, r.is_adult, c.has_image_revision
FROM character_revisions r
JOIN characters c ON c.id = r.character_id
WHERE r.status = 'pending'
ORDER BY submitted_at;

ALTER VIEW character_review_queue SET (security_invoker = true);
