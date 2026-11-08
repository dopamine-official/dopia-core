package com.dopia.chat

import com.dopia.account.AccountService
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
        val adultMode: Boolean,
        val locale: String,
        val accountId: UUID,
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
    private val accounts: AccountService,
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
    ): OpenResponse =
        tx.execute {
            accounts.assertGuestWritable(identity)
            val character =
                try {
                    characters.forChat(characterId, locale.locale, characters.adultAllowed(identity, locale))
                } catch (error: CharacterNotFound) {
                    throw notFound()
                }
            repository.latestRoom(identity.accountId, characterId)?.let { return@execute OpenResponse(it.id, false) }
            if (!character.canOpenNewRoom) throw notFound()
            val roomId = repository.insertRoom(identity.accountId, characterId, character.isAdult)
            repository.insertMessage(roomId, null, 1, "assistant", character.firstMessage)
            events.record(
                identity.accountId,
                "chat_room_opened",
                mapOf("character_id" to characterId.toString(), "room_id" to roomId.toString()),
            )
            OpenResponse(roomId, true)
        }!!

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
            val character = characters.forChat(room.characterId, locale.locale, adultAllowed = true)
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
            val names = characters.forChat(rooms.map { it.characterId }.toSet(), locale.locale)
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

    // 4-1-7 delete

    fun delete(
        identity: Identity,
        roomId: UUID,
    ) {
        tx.execute {
            accounts.assertGuestWritable(identity)
            val room = repository.lockRoom(roomId)?.takeIf { !it.deleted && it.ownerAccountId == identity.accountId } ?: throw notFound()
            repository.deleteRoom(room.id)
            events.record(identity.accountId, "chat_deleted", mapOf("room_id" to roomId.toString()))
        }
    }

    // 4-1-3 send, steps 1 to 5

    fun startTurn(
        identity: Identity,
        locale: RequestLocale,
        roomId: UUID,
        content: String,
        clientMessageId: UUID,
    ): TurnStart =
        try {
            tx.execute {
                accounts.assertGuestWritable(identity)
                val room =
                    repository.lockRoom(roomId)?.takeIf { !it.deleted && it.ownerAccountId == identity.accountId } ?: throw notFound()
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
                // PAYMENT is not specified yet: no deduction, charge_type recorded by account kind.
                val chargeType = if (identity.isGuest) "free_turn" else "credit"
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
                events.record(
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
                )
            }!!
        } catch (error: DuplicateKeyException) {
            // Another request won the one-generating-turn or idempotency race.
            throw inProgress()
        }

    // Steps 10 to 13: completion and failure, confirmed only for this worker's generating turn.

    fun complete(
        started: TurnStart.Started,
        output: String,
        meta: AiMeta,
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
                "turn_completed",
                mapOf(
                    "room_id" to started.roomId.toString(),
                    "client_message_id" to started.clientMessageId.toString(),
                ),
            )
        }
        return assistantId
    }

    fun fail(
        started: TurnStart.Started,
        code: String,
    ): Boolean {
        val failed =
            tx.execute {
                val turn = repository.lockTurn(started.turnId) ?: return@execute false
                if (turn.status != "generating" || turn.workerId != properties.instanceId) return@execute false
                repository.failTurn(started.turnId, code)
            } ?: false
        if (failed) {
            events.record(
                started.accountId,
                "turn_failed",
                mapOf(
                    "room_id" to started.roomId.toString(),
                    "client_message_id" to started.clientMessageId.toString(),
                    "code" to code,
                ),
            )
        }
        return failed
    }

    fun heartbeat(turnId: UUID): Boolean = repository.heartbeat(turnId, properties.instanceId)

    /** Error code stored on a turn that was ended by someone else (recovery, another worker). */
    fun storedErrorCode(turnId: UUID): String? = repository.findTurnById(turnId)?.errorCode

    /** AI request material (4-2-6): summary, un-summarized history before this input. */
    fun history(started: TurnStart.Started): Pair<String, List<MessageRow>> {
        val summary = repository.summaryOf(started.roomId)
        val after = summary?.lastSummarizedSeq ?: 0
        return (summary?.content ?: "") to repository.historyAfter(started.roomId, after, started.userMessageSeq)
    }

    // 4-1-6 owner transfer, inside ACCOUNT's merge transaction

    fun transferOwner(
        guestAccountId: UUID,
        memberAccountId: UUID,
    ) {
        repository.transferRooms(guestAccountId, memberAccountId)
    }

    // 4-1-5 lost turn recovery

    @Scheduled(initialDelayString = "PT2S", fixedDelayString = "PT15S")
    fun recoverLostTurns() {
        runCatching {
            val lost = repository.failLostTurns(properties.turns.lostAfter.seconds)
            if (lost.isNotEmpty()) log.warn("marked {} generating turn(s) as worker_lost", lost.size)
        }.onFailure { log.warn("lost turn recovery failed", it) }
    }
}
