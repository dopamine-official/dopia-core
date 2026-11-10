-- ACCOUNT: DOMAIN/ACCOUNT/BE/3-2-DB-SCHEMA.md (3-2-3 accounts), CHAT: DOMAIN/CHAT/BE/3-2-DB-SCHEMA.md (chat_turns).
-- Chat is for members only: guests have nothing to move at login, and there are no free turns.

DROP INDEX accounts_merge_pending;

ALTER TABLE accounts
    DROP CONSTRAINT accounts_guest_merge_only,
    DROP CONSTRAINT accounts_merge_order,
    DROP COLUMN merge_target_account_id,
    DROP COLUMN merged_into_account_id;

-- Only development data has guest free turns; they count as credit turns from now on.
UPDATE chat_turns SET charge_type = 'credit' WHERE charge_type = 'free_turn';

ALTER TABLE chat_turns
    DROP CONSTRAINT chat_turns_charge_type_check,
    ADD CONSTRAINT chat_turns_charge_type_check CHECK (charge_type = 'credit');
