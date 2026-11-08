-- CHARACTER: DOMAIN/CHARACTER/BE/3-2-DB-SCHEMA.md

-- A localized text is a JSON object of locale -> string with a non-empty source value.
CREATE FUNCTION localized_text_valid(value jsonb, source_locale text) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS
$$
SELECT jsonb_typeof(value) = 'object'
   AND NOT EXISTS (SELECT 1 FROM jsonb_each(value) AS entry WHERE jsonb_typeof(entry.value) <> 'string')
   AND coalesce(value ->> source_locale, '') <> ''
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS
$$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END
$$;

CREATE TABLE characters (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_locale    text NOT NULL,
    name             jsonb NOT NULL,
    tagline          jsonb NOT NULL,
    first_message    jsonb NOT NULL,
    personality      jsonb NOT NULL,
    speech_style     jsonb NOT NULL,
    world_setting    jsonb NOT NULL,
    gender           text NOT NULL CHECK (gender IN ('female', 'male', 'other')),
    image_url        text NOT NULL,
    creator_name     text NOT NULL,
    banner_image_url text,
    is_banner        boolean NOT NULL DEFAULT false,
    is_adult         boolean NOT NULL DEFAULT false,
    is_public        boolean NOT NULL DEFAULT false,
    deleted_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT characters_localized_text CHECK (
        localized_text_valid(name, source_locale)
        AND localized_text_valid(tagline, source_locale)
        AND localized_text_valid(first_message, source_locale)
        AND localized_text_valid(personality, source_locale)
        AND localized_text_valid(speech_style, source_locale)
        AND localized_text_valid(world_setting, source_locale)
    ),
    CONSTRAINT characters_banner_image CHECK (NOT is_banner OR banner_image_url IS NOT NULL)
);

CREATE UNIQUE INDEX characters_single_banner
    ON characters (is_banner)
    WHERE is_banner AND deleted_at IS NULL;

CREATE TRIGGER characters_updated_at
    BEFORE UPDATE ON characters
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE home_sections (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_locale text NOT NULL,
    name          jsonb NOT NULL,
    position      integer NOT NULL,
    is_public     boolean NOT NULL DEFAULT false,
    deleted_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT home_sections_localized_name CHECK (localized_text_valid(name, source_locale))
);

CREATE UNIQUE INDEX home_sections_position
    ON home_sections (position)
    WHERE deleted_at IS NULL;

CREATE TRIGGER home_sections_updated_at
    BEFORE UPDATE ON home_sections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE home_section_characters (
    section_id   uuid NOT NULL REFERENCES home_sections (id) ON DELETE CASCADE,
    character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    position     integer NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (section_id, character_id),
    CONSTRAINT home_section_characters_position UNIQUE (section_id, position)
);
