-- The home banner is a picture with an optional link, not a character (CHARACTER 3-2-10).
-- Until now a character row carried `is_banner` and `banner_image_url`.

CREATE TABLE home_banners (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    image_url  text NOT NULL CHECK (image_url <> ''),
    -- NULL: a picture that does nothing when pressed.
    link_url   text,
    is_public  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- A path inside the service or an https address; nothing a browser would run as script.
    CONSTRAINT home_banners_link CHECK (
        link_url IS NULL
        OR (link_url LIKE '/%' AND link_url NOT LIKE '//%')
        OR link_url LIKE 'https://%'
    )
);

CREATE TRIGGER home_banners_updated_at
    BEFORE UPDATE ON home_banners
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Existing banners are not carried over; an operator adds rows to home_banners.
-- Dropping the columns drops their index and CHECK with them.
ALTER TABLE characters
    DROP COLUMN is_banner,
    DROP COLUMN banner_image_url;
