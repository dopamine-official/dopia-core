-- ACCOUNT: DOMAIN/ACCOUNT/BE/3-2-DB-SCHEMA.md (3-2-5 account_identities). Apple sign-in is removed.
-- Only development data can hold Apple links (the preview's mock login); they go with it.

DELETE FROM account_identities WHERE provider <> 'google';

ALTER TABLE account_identities
    DROP CONSTRAINT account_identities_provider_check,
    ADD CONSTRAINT account_identities_provider_check CHECK (provider IN ('google'));
