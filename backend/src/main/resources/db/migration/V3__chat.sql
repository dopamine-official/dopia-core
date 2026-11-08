-- CHAT: DOMAIN/CHAT/BE/3-2-DB-SCHEMA.md

CREATE TABLE chat_rooms (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id         uuid NOT NULL,
    character_id             uuid NOT NULL,
    is_adult                 boolean NOT NULL,
    last_message_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at               timestamptz,
    summary_job_id           uuid,
    summary_lease_expires_at timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chat_rooms_summary_job
        CHECK ((summary_job_id IS NULL) = (summary_lease_expires_at IS NULL))
);

CREATE INDEX chat_rooms_recent
    ON chat_rooms (owner_account_id, last_message_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX chat_rooms_open
    ON chat_rooms (owner_account_id, character_id, last_message_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE chat_messages (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id    uuid NOT NULL REFERENCES chat_rooms (id) ON DELETE CASCADE,
    turn_id    uuid,
    seq        integer NOT NULL CHECK (seq >= 1),
    role       text NOT NULL CHECK (role IN ('user', 'assistant')),
    content    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chat_messages_seq UNIQUE (room_id, seq),
    -- Let turns and summaries reference a message together with its room (and role).
    CONSTRAINT chat_messages_room_identity UNIQUE (id, room_id),
    CONSTRAINT chat_messages_identity UNIQUE (id, room_id, role)
);

CREATE TABLE chat_turns (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id              uuid NOT NULL REFERENCES chat_rooms (id) ON DELETE CASCADE,
    client_message_id    uuid NOT NULL,
    ai_request_id        text NOT NULL,
    status               text NOT NULL CHECK (status IN ('generating', 'completed', 'failed')),
    user_message_id      uuid NOT NULL,
    assistant_message_id uuid,
    charge_type          text NOT NULL CHECK (charge_type IN ('free_turn', 'credit')),
    charge_ref           text,
    refunded_at          timestamptz,
    adult_mode           boolean NOT NULL,
    model                text,
    model_provider       text,
    prompt_version       text,
    input_token_count    integer,
    output_token_count   integer,
    ttft_ms              integer,
    generation_ms        integer,
    worker_id            text,
    heartbeat_at         timestamptz NOT NULL DEFAULT now(),
    error_code           text,
    completed_at         timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    -- Generated constants let the foreign keys below pin each message's role.
    user_role            text GENERATED ALWAYS AS ('user') STORED,
    assistant_role       text GENERATED ALWAYS AS ('assistant') STORED,
    -- Lets messages reference a turn together with its room.
    CONSTRAINT chat_turns_room_identity UNIQUE (id, room_id),
    CONSTRAINT chat_turns_idempotent UNIQUE (room_id, client_message_id),
    CONSTRAINT chat_turns_ai_request UNIQUE (ai_request_id),
    CONSTRAINT chat_turns_user_message UNIQUE (user_message_id),
    CONSTRAINT chat_turns_assistant_message UNIQUE (assistant_message_id),
    CONSTRAINT chat_turns_completed_has_reply
        CHECK (status <> 'completed' OR assistant_message_id IS NOT NULL),
    CONSTRAINT chat_turns_user_message_link
        FOREIGN KEY (user_message_id, room_id, user_role)
        REFERENCES chat_messages (id, room_id, role) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT chat_turns_assistant_message_link
        FOREIGN KEY (assistant_message_id, room_id, assistant_role)
        REFERENCES chat_messages (id, room_id, role) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX chat_turns_one_generating
    ON chat_turns (room_id)
    WHERE status = 'generating';
CREATE INDEX chat_turns_heartbeat
    ON chat_turns (heartbeat_at)
    WHERE status = 'generating';

-- A message's turn must belong to the same room and link back to that message.
ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_turn
        FOREIGN KEY (turn_id, room_id) REFERENCES chat_turns (id, room_id)
        DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX chat_messages_turn_idx ON chat_messages (turn_id);

CREATE FUNCTION chat_message_turn_link_check() RETURNS trigger
    LANGUAGE plpgsql AS
$$
BEGIN
    IF NEW.turn_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM chat_turns t
        WHERE t.id = NEW.turn_id
          AND ((NEW.role = 'user' AND t.user_message_id = NEW.id)
               OR (NEW.role = 'assistant' AND t.assistant_message_id = NEW.id))
    ) THEN
        RAISE EXCEPTION 'chat_messages.turn_id % does not link back to message %', NEW.turn_id, NEW.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER chat_messages_turn_link
    AFTER INSERT OR UPDATE OF turn_id, role ON chat_messages
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION chat_message_turn_link_check();

CREATE TABLE chat_summaries (
    room_id                    uuid PRIMARY KEY REFERENCES chat_rooms (id) ON DELETE CASCADE,
    content                    text NOT NULL,
    last_summarized_message_id uuid NOT NULL,
    prompt_version             text,
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chat_summaries_last_message
        FOREIGN KEY (last_summarized_message_id, room_id) REFERENCES chat_messages (id, room_id)
);
