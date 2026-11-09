package com.dopia.chat

import com.dopia.character.CharacterService
import com.dopia.chat.ai.AiCharacter
import com.dopia.chat.ai.AiClient
import com.dopia.chat.ai.AiFailure
import com.dopia.chat.ai.AiGeneration
import com.dopia.chat.ai.AiHistoryItem
import com.dopia.chat.ai.AiTurnListener
import com.dopia.chat.ai.AiTurnRequest
import com.dopia.common.ErrorBody
import com.dopia.config.AppProperties
import org.slf4j.LoggerFactory
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class AcceptedEvent(
    val userMessageId: UUID,
)

data class TokenEvent(
    val text: String,
)

data class CompletedEvent(
    val assistantMessageId: UUID,
    val content: String,
)

/** Executes turns off the request thread (4-1-3 steps 6 to 13) and relays the stream to the web. */
@Component
class TurnRunner(
    private val chat: ChatService,
    private val characters: CharacterService,
    private val ai: AiClient,
    private val properties: AppProperties,
) {
    private val log = LoggerFactory.getLogger(TurnRunner::class.java)
    private val capacity = Semaphore(properties.turns.maxConcurrent)
    private val workers = Executors.newVirtualThreadPerTaskExecutor()

    // The scheduler only ticks; each DB update runs on its own virtual thread so one slow
    // heartbeat cannot delay every other turn's heartbeat (and get them all marked worker_lost).
    private val heartbeats = Executors.newSingleThreadScheduledExecutor { Thread(it, "turn-heartbeat").apply { isDaemon = true } }

    /** Returns false when the executor is saturated (server_busy). */
    fun submit(
        started: TurnStart.Started,
        emitter: SseEmitter,
    ): Boolean {
        if (!capacity.tryAcquire()) return false
        workers.execute {
            try {
                run(started, emitter)
            } finally {
                capacity.release()
            }
        }
        return true
    }

    private fun run(
        started: TurnStart.Started,
        emitter: SseEmitter,
    ) {
        val stream = WebStream(emitter)
        stream.send("accepted", AcceptedEvent(started.userMessageId))
        val wanted = AtomicBoolean(true)
        val beating = AtomicBoolean(false)
        // A failure before the first token is before_ai; after it, stream (TRACKING-PLAN 8-3-3).
        val streaming = AtomicBoolean(false)
        val beat =
            heartbeats.scheduleAtFixedRate(
                {
                    // Skip a tick while the previous update is still running instead of piling up.
                    if (beating.compareAndSet(false, true)) {
                        workers.execute {
                            try {
                                if (!chat.heartbeat(started.turnId)) wanted.set(false)
                            } catch (error: Exception) {
                                log.warn("heartbeat for turn {} failed", started.turnId, error)
                            } finally {
                                beating.set(false)
                            }
                        }
                    }
                },
                properties.turns.heartbeat.toMillis(),
                properties.turns.heartbeat.toMillis(),
                TimeUnit.MILLISECONDS,
            )
        try {
            if (!chat.heartbeat(started.turnId)) {
                sendStoredFailure(started, stream)
                return
            }
            val character = characters.forChat(started.characterId, started.locale, adultAllowed = true)
            val (summary, history) = chat.history(started)
            val request =
                AiTurnRequest(
                    character =
                        AiCharacter(
                            character.name,
                            character.gender,
                            character.personality,
                            character.speechStyle,
                            character.worldSetting,
                            started.isAdult,
                        ),
                    history = history.map { AiHistoryItem(it.role, it.content) },
                    summary = summary,
                    userInput = started.userInput,
                    generation = AiGeneration(started.locale),
                )
            val result =
                ai.turn(
                    started.aiRequestId,
                    started.accountId,
                    request,
                    started.characterId,
                    object : AiTurnListener {
                        override fun onToken(text: String) {
                            streaming.set(true)
                            stream.send("token", TokenEvent(text))
                        }

                        override fun onWebDisconnectRequested() = stream.close()

                        override fun stillWanted() = wanted.get()
                    },
                )
            val assistantId =
                chat.complete(started, result.output, result.meta, AiInputShape(history.size, summary.isNotEmpty()))
            if (assistantId != null) {
                stream.send("completed", CompletedEvent(assistantId, result.output))
            } else {
                sendStoredFailure(started, stream)
            }
        } catch (error: AiFailure) {
            if (chat.fail(started, error.code, stage(streaming))) {
                stream.send("failed", ErrorBody(error.code, error.message, emptyList()))
            } else {
                sendStoredFailure(started, stream)
            }
        } catch (error: Exception) {
            log.error("turn {} failed", started.turnId, error)
            if (chat.fail(started, "ai_unavailable", stage(streaming))) {
                stream.send("failed", ErrorBody("ai_unavailable", "ai request failed", emptyList()))
            } else {
                sendStoredFailure(started, stream)
            }
        } finally {
            beat.cancel(false)
            stream.close()
        }
    }

    private fun stage(streaming: AtomicBoolean) = if (streaming.get()) "stream" else "before_ai"

    /** The turn was finished by someone else (recovery, another instance): tell the web why before closing. */
    private fun sendStoredFailure(
        started: TurnStart.Started,
        stream: WebStream,
    ) {
        val code = runCatching { chat.storedErrorCode(started.turnId) }.getOrNull() ?: "internal_error"
        stream.send("failed", ErrorBody(code, "turn ended elsewhere", emptyList()))
    }

    /** Web writes never affect the turn: failures are ignored and the stream can be closed early. */
    class WebStream(
        private val emitter: SseEmitter,
    ) {
        private val closed = AtomicBoolean(false)

        fun send(
            name: String,
            data: Any,
        ) {
            if (closed.get()) return
            runCatching { emitter.send(SseEmitter.event().name(name).data(data, MediaType.APPLICATION_JSON)) }
                .onFailure { closed.set(true) }
        }

        fun close() {
            if (closed.compareAndSet(false, true)) runCatching { emitter.complete() }
        }
    }
}
