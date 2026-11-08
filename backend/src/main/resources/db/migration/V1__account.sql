-- ACCOUNT: DOMAIN/ACCOUNT/BE/3-2-DB-SCHEMA.md

CREATE TABLE accounts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    is_guest                boolean NOT NULL,
    nickname                text,
    photo_url               text,
    email                   text,
    adult_mode              boolean NOT NULL DEFAULT false,
    adult_verified_at       timestamptz,
    merge_target_account_id uuid REFERENCES accounts (id),
    merged_into_account_id  uuid REFERENCES accounts (id),
    last_login_at           timestamptz,
    deleted_at              timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT accounts_member_nickname
        CHECK (is_guest OR nickname IS NOT NULL),
    CONSTRAINT accounts_adult_mode_verified
        CHECK (NOT adult_mode OR adult_verified_at IS NOT NULL),
    CONSTRAINT accounts_guest_merge_only
        CHECK ((merge_target_account_id IS NULL AND merged_into_account_id IS NULL) OR is_guest),
    CONSTRAINT accounts_merge_order
        CHECK (merged_into_account_id IS NULL
               OR (merge_target_account_id IS NOT NULL AND merged_into_account_id = merge_target_account_id))
);

CREATE UNIQUE INDEX accounts_nickname_unique
    ON accounts (lower(nickname))
    WHERE deleted_at IS NULL AND nickname IS NOT NULL;
CREATE INDEX accounts_merge_pending
    ON accounts (id)
    WHERE merge_target_account_id IS NOT NULL AND merged_into_account_id IS NULL;
CREATE INDEX accounts_deleted
    ON accounts (deleted_at)
    WHERE deleted_at IS NOT NULL;

CREATE TABLE guest_identifiers (
    account_id   uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    token_hash   text NOT NULL UNIQUE,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_identities (
    provider         text NOT NULL CHECK (provider IN ('google', 'apple')),
    provider_subject text NOT NULL,
    account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_subject),
    CONSTRAINT account_identities_one_per_provider UNIQUE (account_id, provider)
);

CREATE TABLE sessions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE,
    account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_account_active ON sessions (account_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires ON sessions (expires_at);
