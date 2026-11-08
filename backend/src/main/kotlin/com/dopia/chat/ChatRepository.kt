package com.dopia.chat

import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID

data class RoomRow(
    val id: UUID,
    val ownerAccountId: UUID,
    val characterId: UUID,
    val isAdult: Boolean,
    val lastMessageAt: Instant,
    val deleted: Boolean,
)

data class MessageRow(
    val id: UUID,
    val roomId: UUID,
    val turnId: UUID?,
    val seq: Int,
    val role: String,
    val content: String,
    val createdAt: Instant,
    val clientMessageId: UUID?,
    val turnStatus: String?,
    val errorCode: String?,
)

data class TurnRow(
    val id: UUID,
    val roomId: UUID,
    val clientMessageId: UUID,
    val aiRequestId: String,
    val status: String,
    val userMessageId: UUID,
    val assistantMessageId: UUID?,
    val workerId: String?,
    val errorCode: String?,
)

data class AiMeta(
    val model: String?,
    val provider: String?,
    val promptVersion: String?,
    val inputTokenCount: Int?,
    val outputTokenCount: Int?,
    val ttftMs: Int?,
    val generationMs: Int?,
)

@Repository
class ChatRepository(private val jdbc: JdbcClient) {
    private fun ResultSet.instant(column: String): Instant? = getObject(column, OffsetDateTime::class.java)?.toInstant()
    private fun ResultSet.uuid(column: String): UUID? = getObject(column, UUID::class.java)

    private val room = RowMapper { rs: ResultSet, _: Int ->
        RoomRow(
            id = rs.uuid("id")!!,
            ownerAccountId = rs.uuid("owner_account_id")!!,
            characterId = rs.uuid("character_id")!!,
            isAdult = rs.getBoolean("is_adult"),
            lastMessageAt = rs.instant("last_message_at")!!,
            deleted = rs.getObject("deleted_at") != null,
        )
    }
    private val roomColumns = "id, owner_account_id, character_id, is_adult, last_message_at, deleted_at"

    private val message = RowMapper { rs: ResultSet, _: Int ->
        MessageRow(
            id = rs.uuid("id")!!,
            roomId = rs.uuid("room_id")!!,
            turnId = rs.uuid("turn_id"),
            seq = rs.getInt("seq"),
            role = rs.getString("role"),
            content = rs.getString("content"),
            createdAt = rs.instant("created_at")!!,
            clientMessageId = rs.uuid("client_message_id"),
            turnStatus = rs.getString("turn_status"),
            errorCode = rs.getString("error_code"),
        )
    }
    private val messageSelect = """
        SELECT m.id, m.room_id, m.turn_id, m.seq, m.role, m.content, m.created_at,
               t.client_message_id, t.status AS turn_status, t.error_code
        FROM chat_messages m LEFT JOIN chat_turns t ON t.id = m.turn_id
    """

    private val turn = RowMapper { rs: ResultSet, _: Int ->
        TurnRow(
            id = rs.uuid("id")!!,
            roomId = rs.uuid("room_id")!!,
            clientMessageId = rs.uuid("client_message_id")!!,
            aiRequestId = rs.getString("ai_request_id"),
            status = rs.getString("status"),
            userMessageId = rs.uuid("user_message_id")!!,
            assistantMessageId = rs.uuid("assistant_message_id"),
            workerId = rs.getString("worker_id"),
            errorCode = rs.getString("error_code"),
        )
    }
    private val turnColumns = "id, room_id, client_message_id, ai_request_id, status, user_message_id, assistant_message_id, worker_id, error_code"

    // Rooms

    fun findRoom(id: UUID): RoomRow? =
        jdbc.sql("SELECT $roomColumns FROM chat_rooms WHERE id = :id").param("id", id).query(room).optional().orElse(null)

    fun lockRoom(id: UUID): RoomRow? =
        jdbc.sql("SELECT $roomColumns FROM chat_rooms WHERE id = :id FOR UPDATE").param("id", id).query(room).optional().orElse(null)

    fun latestRoom(owner: UUID, characterId: UUID): RoomRow? =
        jdbc.sql(
            "SELECT $roomColumns FROM chat_rooms WHERE owner_account_id = :owner AND character_id = :character " +
                "AND deleted_at IS NULL ORDER BY last_message_at DESC LIMIT 1",
        ).param("owner", owner).param("character", characterId).query(room).optional().orElse(null)

    fun roomsOf(owner: UUID): List<RoomRow> =
        jdbc.sql("SELECT $roomColumns FROM chat_rooms WHERE owner_account_id = :owner AND deleted_at IS NULL ORDER BY last_message_at DESC")
            .param("owner", owner).query(room).list()

    fun insertRoom(owner: UUID, characterId: UUID, isAdult: Boolean): UUID =
        jdbc.sql("INSERT INTO chat_rooms (owner_account_id, character_id, is_adult) VALUES (:owner, :character, :adult) RETURNING id")
            .param("owner", owner).param("character", characterId).param("adult", isAdult).query(UUID::class.java).single()

    fun touchRoom(id: UUID) {
        jdbc.sql("UPDATE chat_rooms SET last_message_at = now() WHERE id = :id").param("id", id).update()
    }

    fun deleteRoom(id: UUID) {
        jdbc.sql("UPDATE chat_rooms SET deleted_at = now() WHERE id = :id").param("id", id).update()
    }

    fun transferRooms(from: UUID, to: UUID): Int =
        jdbc.sql("UPDATE chat_rooms SET owner_account_id = :to WHERE owner_account_id = :from")
            .param("from", from).param("to", to).update()

    // Messages

    fun messagesOf(roomId: UUID): List<MessageRow> =
        jdbc.sql("$messageSelect WHERE m.room_id = :room ORDER BY m.seq").param("room", roomId).query(message).list()

    /** Messages after the given seq whose turn is not failed, in order. */
    fun historyAfter(roomId: UUID, afterSeq: Int, beforeSeq: Int): List<MessageRow> =
        jdbc.sql(
            "$messageSelect WHERE m.room_id = :room AND m.seq > :after AND m.seq < :before " +
                "AND (t.status IS NULL OR t.status = 'completed') ORDER BY m.seq",
        ).param("room", roomId).param("after", afterSeq).param("before", beforeSeq).query(message).list()

    /** Latest message per room excluding failed turns, for the recent list. */
    fun lastMessages(roomIds: Collection<UUID>): Map<UUID, String> =
        if (roomIds.isEmpty()) emptyMap()
        else jdbc.sql(
            """
            SELECT DISTINCT ON (m.room_id) m.room_id, m.content
            FROM chat_messages m LEFT JOIN chat_turns t ON t.id = m.turn_id
            WHERE m.room_id = ANY(:rooms) AND (t.status IS NULL OR t.status <> 'failed')
            ORDER BY m.room_id, m.seq DESC
            """,
        ).param("rooms", roomIds.toTypedArray())
            .query { rs, _ -> rs.uuid("room_id")!! to rs.getString("content") }.list().toMap()

    fun findMessage(id: UUID): MessageRow? =
        jdbc.sql("$messageSelect WHERE m.id = :id").param("id", id).query(message).optional().orElse(null)

    fun nextSeq(roomId: UUID): Int =
        jdbc.sql("SELECT coalesce(max(seq), 0) + 1 FROM chat_messages WHERE room_id = :room").param("room", roomId)
            .query(Int::class.java).single()

    fun insertMessage(roomId: UUID, turnId: UUID?, seq: Int, role: String, content: String): UUID =
        jdbc.sql("INSERT INTO chat_messages (room_id, turn_id, seq, role, content) VALUES (:room, :turn, :seq, :role, :content) RETURNING id")
            .param("room", roomId).param("turn", turnId).param("seq", seq).param("role", role).param("content", content)
            .query(UUID::class.java).single()

    fun linkMessageTurn(messageId: UUID, turnId: UUID) {
        jdbc.sql("UPDATE chat_messages SET turn_id = :turn WHERE id = :id").param("turn", turnId).param("id", messageId).update()
    }

    // Turns

    fun findTurnById(id: UUID): TurnRow? =
        jdbc.sql("SELECT $turnColumns FROM chat_turns WHERE id = :id").param("id", id).query(turn).optional().orElse(null)

    fun findTurn(roomId: UUID, clientMessageId: UUID): TurnRow? =
        jdbc.sql("SELECT $turnColumns FROM chat_turns WHERE room_id = :room AND client_message_id = :client")
            .param("room", roomId).param("client", clientMessageId).query(turn).optional().orElse(null)

    fun lockTurn(id: UUID): TurnRow? =
        jdbc.sql("SELECT $turnColumns FROM chat_turns WHERE id = :id FOR UPDATE").param("id", id).query(turn).optional().orElse(null)

    fun hasGeneratingTurn(roomId: UUID): Boolean =
        jdbc.sql("SELECT count(*) FROM chat_turns WHERE room_id = :room AND status = 'generating'").param("room", roomId)
            .query(Long::class.java).single() > 0

    fun insertTurn(
        roomId: UUID, clientMessageId: UUID, aiRequestId: String, userMessageId: UUID,
        chargeType: String, adultMode: Boolean, workerId: String,
    ): UUID =
        jdbc.sql(
            """
            INSERT INTO chat_turns (room_id, client_message_id, ai_request_id, status, user_message_id, charge_type, adult_mode, worker_id)
            VALUES (:room, :client, :request, 'generating', :user, :charge, :adult, :worker) RETURNING id
            """,
        ).param("room", roomId).param("client", clientMessageId).param("request", aiRequestId).param("user", userMessageId)
            .param("charge", chargeType).param("adult", adultMode).param("worker", workerId).query(UUID::class.java).single()

    /** Returns false when the turn is no longer this worker's generating turn. */
    fun heartbeat(turnId: UUID, workerId: String): Boolean =
        jdbc.sql("UPDATE chat_turns SET heartbeat_at = now() WHERE id = :id AND status = 'generating' AND worker_id = :worker")
            .param("id", turnId).param("worker", workerId).update() == 1

    fun completeTurn(turnId: UUID, assistantMessageId: UUID, meta: AiMeta): Boolean =
        jdbc.sql(
            """
            UPDATE chat_turns SET status = 'completed', assistant_message_id = :assistant, completed_at = now(),
                model = :model, model_provider = :provider, prompt_version = :prompt,
                input_token_count = :input, output_token_count = :output, ttft_ms = :ttft, generation_ms = :generation
            WHERE id = :id AND status = 'generating'
            """,
        ).param("id", turnId).param("assistant", assistantMessageId).param("model", meta.model).param("provider", meta.provider)
            .param("prompt", meta.promptVersion).param("input", meta.inputTokenCount).param("output", meta.outputTokenCount)
            .param("ttft", meta.ttftMs).param("generation", meta.generationMs).update() == 1

    fun failTurn(turnId: UUID, code: String): Boolean =
        jdbc.sql("UPDATE chat_turns SET status = 'failed', error_code = :code, completed_at = now() WHERE id = :id AND status = 'generating'")
            .param("id", turnId).param("code", code).update() == 1

    fun failLostTurns(lostAfterSeconds: Long): List<UUID> =
        jdbc.sql(
            """
            UPDATE chat_turns SET status = 'failed', error_code = 'worker_lost', completed_at = now()
            WHERE status = 'generating' AND heartbeat_at < now() - make_interval(secs => :seconds)
            RETURNING id
            """,
        ).param("seconds", lostAfterSeconds).query(UUID::class.java).list().filterNotNull()

    // Summaries

    data class SummaryRow(val content: String, val lastSummarizedSeq: Int)

    fun summaryOf(roomId: UUID): SummaryRow? =
        jdbc.sql(
            "SELECT s.content, m.seq FROM chat_summaries s JOIN chat_messages m ON m.id = s.last_summarized_message_id WHERE s.room_id = :room",
        ).param("room", roomId).query { rs, _ -> SummaryRow(rs.getString("content"), rs.getInt("seq")) }.optional().orElse(null)
}
