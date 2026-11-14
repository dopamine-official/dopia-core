package com.dopia.chat

import com.dopia.character.CharacterNotFound
import com.dopia.character.CharacterService
import com.dopia.common.ApiException
import com.dopia.common.AppEvents
import com.dopia.common.FieldError
import com.dopia.common.Identity
import com.dopia.common.RequestLocale
import com.dopia.config.AppProperties
import org.slf4j.LoggerFactory
import org.springframework.dao.DuplicateKeyException
import org.springframework.http.HttpStatus
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant
import java.util.UUID

// Responses (CHAT 4-2)
data class CharacterSummary(
    val id: UUID,
    val name: String,
    val imageUrl: String,
)

data class OpenResponse(
    val roomId: UUID,
    val created: Boolean,
)

data class RecentChat(
    val roomId: UUID,
    val character: CharacterSummary,
    val lastMessage: String?,
    val updatedAt: Instant,
)

data class RecentResponse(
    val chats: List<RecentChat>,
)

data class MessageView(
    val id: UUID,
    val role: String,
    val content: String,
    val createdAt: Instant,
    val clientMessageId: UUID?,
    val turnStatus: String?,
    val errorCode: String?,
)

data class RoomView(
    val roomId: UUID,
    val character: CharacterSummary,
    val messages: List<MessageView>,
    val generating: Boolean,
)

/** What the room contributes to an AI turn request (4-2-6). */
data class AiMaterial(
    val prologue: String,
    val summary: String,
    val history: List<MessageRow>,
)

/** What the AI request carried besides the input, for `server_turn_completed`. */
data class AiInputShape(
    val historyCount: Int,
    val hasSummary: Boolean,
)

/** Characters as people count them (code points), for message lengths in events. */
fun textLength(text: String): Int = text.codePointCount(0, text.length)

/** Outcome of a send request before the stream opens. */
sealed interface TurnStart {
    /** A new generating turn that the runner must execute. */
    data class Started(
        val turnId: UUID,
        val roomId: UUID,
        val characterId: UUID,
        val userMessageId: UUID,
        val userMessageSeq: Int,
        val userInput: String,
        val clientMessageId: UUID,
        val aiRequestId: String,
        val isAdult: Boolean,
        val locale: String,
        val accountId: UUID,
        // The sender's adult mode and charge kind, for `server_turn_completed`.
        val adultMode: Boolean,
        val chargeType: String,
    ) : TurnStart

    /** Same client_message_id as a finished turn: replay the stored result. */
    data class Replay(
        val userMessageId: UUID,
        val assistantMessageId: UUID?,
        val content: String?,
        val errorCode: String?,
    ) : TurnStart
}

@Service
class ChatService(
    private val repository: ChatRepository,
    private val characters: CharacterService,
    private val tx: TransactionTemplate,
    private val events: AppEvents,
    private val properties: AppProperties,
) {
    private val log = LoggerFactory.getLogger(ChatService::class.java)

    private fun notFound() = ApiException("room_not_found", HttpStatus.NOT_FOUND, message = "room not found")

    private fun inProgress() = ApiException("generation_in_progress", HttpStatus.CONFLICT, message = "a reply is being generated")

    // 4-1-1 open

    fun open(
        identity: Identity,
        locale: RequestLocale,
        characterId: UUID,
    ): OpenResponse {
        var isAdult = false
        val opened =
            tx.execute {
                val character =
                    try {
                        characters.forChat(characterId, locale.locale, characters.adultAllowed(identity, locale), identity.accountId)
                    } catch (error: CharacterNotFound) {
                        throw notFound()
                    }
                repository.latestRoom(identity.accountId, characterId)?.let { return@execute OpenResponse(it.id, false) }
                if (!character.canOpenNewRoom) throw notFound()
                val roomId = repository.insertRoom(identity.accountId, characterId, character.isAdult)
                repository.insertMessage(roomId, null, 1, "assistant", character.firstMessage)
                isAdult = character.isAdult
                OpenResponse(roomId, true)
            }!!
        // A room opened again is not a new room (TRACKING-PLAN 8-3-1).
        if (opened.created) {
            events.record(
                identity.accountId,
                "server_room_created",
                mapOf("room_id" to opened.roomId.toString(), "character_id" to characterId.toString(), "is_adult" to isAdult),
            )
        }
        return opened
    }

    // 4-1-2 read

    private fun ownedRoom(
        identity: Identity,
        roomId: UUID,
    ): RoomRow = repository.findRoom(roomId)?.takeIf { !it.deleted && it.ownerAccountId == identity.accountId } ?: throw notFound()

    fun view(
        identity: Identity,
        locale: RequestLocale,
        roomId: UUID,
    ): RoomView =
        tx.execute {
            val room = ownedRoom(identity, roomId)
            val character = characters.forChat(room.characterId, locale.locale, adultAllowed = true, requesterId = identity.accountId)
            val messages = repository.messagesOf(roomId)
            RoomView(
                roomId = roomId,
                character = CharacterSummary(character.id, character.name, character.imageUrl),
                messages =
                    messages.map {
                        MessageView(it.id, it.role, it.content, it.createdAt, it.clientMessageId, it.turnStatus, it.errorCode)
                    },
                generating = messages.any { it.turnStatus == "generating" },
            )
        }!!

    fun recent(
        identity: Identity,
        locale: RequestLocale,
    ): RecentResponse =
        tx.execute {
            val rooms = repository.roomsOf(identity.accountId)
            val names = characters.forChat(rooms.map { it.characterId }.toSet(), locale.locale, identity.accountId)
            val last = repository.lastMessages(rooms.map { it.id })
            RecentResponse(
                rooms.mapNotNull { room ->
                    val character = names[room.characterId] ?: return@mapNotNull null
                    RecentChat(
                        room.id,
                        CharacterSummary(character.id, character.name, character.imageUrl),
                        last[room.id],
                        room.lastMessageAt,
                    )
                },
            )
        }!!

    // 4-1-6 delete

    fun delete(
        identity: Identity,
        roomId: UUID,
    ) {
        val characterId =
            tx.execute {
                val room =
                    repository.lockRoom(roomId)?.takeIf { !it.deleted && it.ownerAccountId == identity.accountId } ?: throw notFound()
                repository.deleteRoom(room.id)
                room.characterId
            }!!
        events.record(
            identity.accountId,
            "server_room_deleted",
            mapOf("room_id" to roomId.toString(), "character_id" to characterId.toString()),
        )
    }

    // 4-1-3 send, steps 1 to 5

    fun startTurn(
        identity: Identity,
        locale: RequestLocale,
        roomId: UUID,
        content: String,
        clientMessageId: UUID,
    ): TurnStart {
        // Known once the room is found, so a refusal after that can say which character.
        var characterId: UUID? = null
        return try {
            tx.execute {
                val room =
                    repository.lockRoom(roomId)?.takeIf { !it.deleted && it.ownerAccountId == identity.accountId } ?: throw notFound()
                characterId = room.characterId
                repository.findTurn(roomId, clientMessageId)?.let { existing ->
                    val userMessage = repository.findMessage(existing.userMessageId)!!
                    if (userMessage.content != content) {
                        throw ApiException.invalidInput(FieldError("client_message_id", "content_mismatch"))
                    }
                    return@execute when (existing.status) {
                        "generating" -> {
                            throw inProgress()
                        }

                        "completed" -> {
                            val reply = repository.findMessage(existing.assistantMessageId!!)!!
                            TurnStart.Replay(existing.userMessageId, reply.id, reply.content, null)
                        }

                        else -> {
                            TurnStart.Replay(existing.userMessageId, null, null, existing.errorCode ?: "internal_error")
                        }
                    }
                }
                if (repository.hasGeneratingTurn(roomId)) throw inProgress()
                // PAYMENT is not specified yet: no deduction. Only members chat, so every turn is a credit turn.
                val chargeType = "credit"
                val seq = repository.nextSeq(roomId)
                val userMessageId = repository.insertMessage(roomId, null, seq, "user", content)
                val aiRequestId = UUID.randomUUID().toString()
                val turnId =
                    repository.insertTurn(
                        roomId,
                        clientMessageId,
                        aiRequestId,
                        userMessageId,
                        chargeType,
                        room.isAdult,
                        properties.instanceId,
                    )
                repository.linkMessageTurn(userMessageId, turnId)
                repository.touchRoom(roomId)
                events.note(
                    identity.accountId,
                    "message_sent",
                    mapOf(
                        "room_id" to roomId.toString(),
                        "client_message_id" to clientMessageId.toString(),
                    ),
                )
                TurnStart.Started(
                    turnId,
                    roomId,
                    room.characterId,
                    userMessageId,
                    seq,
                    content,
                    clientMessageId,
                    aiRequestId,
                    room.isAdult,
                    locale.locale,
                    identity.accountId,
                    identity.adultMode,
                    chargeType,
                )
            }!!
        } catch (error: DuplicateKeyException) {
            // Another request won the one-generating-turn or idempotency race.
            characterId?.let { rejected(identity.accountId, roomId, it, "generation_in_progress") }
            throw inProgress()
        } catch (error: ApiException) {
            if (error.code == "generation_in_progress") characterId?.let { rejected(identity.accountId, roomId, it, error.code) }
            throw error
        }
    }

    /** `server_turn_rejected` (TRACKING-PLAN 8-3-5): refused before any reply was generated. */
    private fun rejected(
        accountId: UUID,
        roomId: UUID,
        characterId: UUID,
        code: String,
    ) = events.record(
        accountId,
        "server_turn_rejected",
        mapOf("room_id" to roomId.toString(), "character_id" to characterId.toString(), "code" to code),
    )

    /**
     * No room to run the turn (server_busy): the turn ends at once and the send is refused.
     * Recorded as a refusal, not a failed reply.
     */
    fun reject(
        started: TurnStart.Started,
        code: String,
    ) {
        val ended =
            tx.execute {
                val turn = repository.lockTurn(started.turnId) ?: return@execute false
                if (turn.status != "generating" || turn.workerId != properties.instanceId) return@execute false
                repository.failTurn(started.turnId, code)
            } ?: false
        if (ended) rejected(started.accountId, started.roomId, started.characterId, code)
    }

    // Steps 10 to 13: completion and failure, confirmed only for this worker's generating turn.

    fun complete(
        started: TurnStart.Started,
        output: String,
        meta: AiMeta,
        sent: AiInputShape,
    ): UUID? {
        val assistantId =
            tx.execute {
                repository.lockRoom(started.roomId)
                val turn = repository.lockTurn(started.turnId) ?: return@execute null
                if (turn.status != "generating" || turn.workerId != properties.instanceId) return@execute null
                val seq = repository.nextSeq(started.roomId)
                val id = repository.insertMessage(started.roomId, started.turnId, seq, "assistant", output)
                repository.completeTurn(started.turnId, id, meta)
                repository.touchRoom(started.roomId)
                id
            }
        if (assistantId != null) {
            events.record(
                started.accountId,
                "server_turn_completed",
                mapOf(
                    "ai_request_id" to started.aiRequestId,
                    "room_id" to started.roomId.toString(),
                    "character_id" to started.characterId.toString(),
                    "turn_id" to started.turnId.toString(),
                    "user_message_length" to textLength(started.userInput),
                    "assistant_message_length" to textLength(output),
                    "adult_mode" to started.adultMode,
                    "charge_type" to started.chargeType,
                    "model" to meta.model,
                    "model_provider" to meta.provider,
                    "prompt_version" to meta.promptVersion,
                    "input_token_count" to meta.inputTokenCount,
                    "output_token_count" to meta.outputTokenCount,
                    "ttft_ms" to meta.ttftMs,
                    "generation_ms" to meta.generationMs,
                    "history_count" to sent.historyCount,
                    "has_summary" to sent.hasSummary,
                ),
            )
        }
        return assistantId
    }

    /** [stage]: before_ai until the first token arrives, stream after (TRACKING-PLAN 8-3-3). */
    fun fail(
        started: TurnStart.Started,
        code: String,
        stage: String,
    ): Boolean {
        val failed =
            tx.execute {
                val turn = repository.lockTurn(started.turnId) ?: return@execute false
                if (turn.status != "generating" || turn.workerId != properties.instanceId) return@execute false
                repository.failTurn(started.turnId, code)
            } ?: false
        if (failed) {
            turnFailed(
                started.accountId,
                started.aiRequestId,
                started.roomId,
                started.characterId,
                started.turnId,
                textLength(started.userInput),
                code,
                stage,
            )
        }
        return failed
    }

    fun heartbeat(turnId: UUID): Boolean = repository.heartbeat(turnId, properties.instanceId)

    /** Error code stored on a turn that was ended by someone else (recovery, another worker). */
    fun storedErrorCode(turnId: UUID): String? = repository.findTurnById(turnId)?.errorCode

    /** AI request material (4-2-6): prologue, summary, un-summarized history before this input. */
    fun aiMaterial(started: TurnStart.Started): AiMaterial {
        val summary = repository.summaryOf(started.roomId)
        val after = summary?.lastSummarizedSeq ?: 0
        return AiMaterial(
            prologue = repository.prologueOf(started.roomId),
            summary = summary?.content ?: "",
            history = repository.historyAfter(started.roomId, after, started.userMessageSeq),
        )
    }

    // 4-1-5 lost turn recovery

    @Scheduled(initialDelayString = "PT2S", fixedDelayString = "PT15S")
    fun recoverLostTurns() {
        runCatching {
            val lost = repository.failLostTurns(properties.turns.lostAfter.seconds)
            if (lost.isNotEmpty()) log.warn("marked {} generating turn(s) as worker_lost", lost.size)
            for (turn in repository.turnFacts(lost)) {
                turnFailed(
                    turn.ownerAccountId,
                    turn.aiRequestId,
                    turn.roomId,
                    turn.characterId,
                    turn.turnId,
                    turn.userMessageLength,
                    "worker_lost",
                    "worker_lost",
                )
            }
        }.onFailure { log.warn("lost turn recovery failed", it) }
    }

    /** `server_turn_failed` (TRACKING-PLAN 8-3-3). PAYMENT is not built, so nothing is refunded yet. */
    private fun turnFailed(
        accountId: UUID,
        aiRequestId: String,
        roomId: UUID,
        characterId: UUID,
        turnId: UUID,
        userMessageLength: Int,
        code: String,
        stage: String,
    ) = events.record(
        accountId,
        "server_turn_failed",
        mapOf(
            "ai_request_id" to aiRequestId,
            "room_id" to roomId.toString(),
            "character_id" to characterId.toString(),
            "turn_id" to turnId.toString(),
            "user_message_length" to userMessageLength,
            "error_code" to code,
            "stage" to stage,
            "refunded" to false,
        ),
    )
}
