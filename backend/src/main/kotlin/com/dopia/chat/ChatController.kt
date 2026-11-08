package com.dopia.chat

import com.dopia.common.ApiException
import com.dopia.common.ErrorBody
import com.dopia.common.FieldError
import com.dopia.common.Identity
import com.dopia.common.RequestLocale
import com.dopia.config.AppProperties
import org.springframework.http.CacheControl
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import java.util.UUID

data class OpenRequest(val characterId: String?)
data class SendRequest(val content: String?, val clientMessageId: String?)

@RestController
@RequestMapping("/api/v1/chats")
class ChatController(private val chat: ChatService, private val runner: TurnRunner, private val properties: AppProperties) {

    private fun uuid(value: String?, field: String): UUID =
        runCatching { UUID.fromString(value) }.getOrElse { throw ApiException.invalidInput(FieldError(field, "invalid_uuid")) }

    @PostMapping("/open")
    fun open(identity: Identity, locale: RequestLocale, @RequestBody body: OpenRequest): OpenResponse =
        chat.open(identity, locale, uuid(body.characterId, "character_id"))

    @GetMapping("/recent")
    fun recent(identity: Identity, locale: RequestLocale): ResponseEntity<RecentResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore().cachePrivate()).body(chat.recent(identity, locale))

    @GetMapping("/{room_id}")
    fun view(identity: Identity, locale: RequestLocale, @PathVariable("room_id") roomId: String): ResponseEntity<RoomView> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore().cachePrivate())
            .body(chat.view(identity, locale, uuid(roomId, "room_id")))

    @DeleteMapping("/{room_id}")
    fun delete(identity: Identity, @PathVariable("room_id") roomId: String): ResponseEntity<Void> {
        chat.delete(identity, uuid(roomId, "room_id"))
        return ResponseEntity.noContent().build()
    }

    @PostMapping("/{room_id}/messages", consumes = [MediaType.APPLICATION_JSON_VALUE], produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun send(identity: Identity, locale: RequestLocale, @PathVariable("room_id") roomId: String, @RequestBody body: SendRequest): ResponseEntity<SseEmitter> {
        val content = body.content?.trim().orEmpty()
        val errors = buildList {
            if (content.isEmpty()) add(FieldError("content", "required"))
            else if (content.length > 4000) add(FieldError("content", "too_long"))
            if (body.clientMessageId.isNullOrBlank()) add(FieldError("client_message_id", "required"))
        }
        if (errors.isNotEmpty()) throw ApiException.invalidInput(*errors.toTypedArray())
        val clientMessageId = uuid(body.clientMessageId, "client_message_id")
        val start = chat.startTurn(identity, locale, uuid(roomId, "room_id"), content, clientMessageId)
        val emitter = SseEmitter(properties.ai.timeout.toMillis() + 30_000)
        when (start) {
            is TurnStart.Replay -> replay(start, emitter)
            is TurnStart.Started -> if (!runner.submit(start, emitter)) {
                chat.fail(start, "server_busy")
                throw ApiException("server_busy", HttpStatus.SERVICE_UNAVAILABLE, message = "generation capacity unavailable")
            }
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.TEXT_EVENT_STREAM).body(emitter)
    }

    private fun replay(start: TurnStart.Replay, emitter: SseEmitter) {
        val stream = TurnRunner.WebStream(emitter)
        stream.send("accepted", AcceptedEvent(start.userMessageId))
        if (start.assistantMessageId != null) {
            stream.send("completed", CompletedEvent(start.assistantMessageId, start.content.orEmpty()))
        } else {
            stream.send("failed", ErrorBody(start.errorCode ?: "internal_error", "stored turn failure", emptyList()))
        }
        stream.close()
    }
}
