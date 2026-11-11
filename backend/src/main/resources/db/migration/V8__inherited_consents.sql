-- ACCOUNT: DOMAIN/ACCOUNT/BE/3-2-DB-SCHEMA.md (3-2-7 account_consents)
-- A logout copies the member's consents to the new guest as inherited (4-1-9). They keep the
-- terms modal closed on that browser but never move on to whoever logs in next (4-1-4).

ALTER TABLE account_consents
    ADD COLUMN inherited boolean NOT NULL DEFAULT false;
