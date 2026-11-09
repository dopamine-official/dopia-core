-- ACCOUNT: DOMAIN/ACCOUNT/BE/3-2-DB-SCHEMA.md (3-2-3 accounts, 3-2-7 account_consents)

ALTER TABLE accounts
    ADD COLUMN gender     text CHECK (gender IN ('male', 'female')),
    ADD COLUMN birth_date date,
    ADD CONSTRAINT accounts_adult_submission_pair
        CHECK ((gender IS NULL) = (birth_date IS NULL)),
    ADD CONSTRAINT accounts_adult_verified_birth_date
        CHECK (adult_verified_at IS NULL OR birth_date IS NOT NULL);

CREATE TABLE account_consents (
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    consent_id text NOT NULL,
    version    text NOT NULL,
    agreed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, consent_id, version)
);
