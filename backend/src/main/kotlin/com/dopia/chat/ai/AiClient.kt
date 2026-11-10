package com.dopia.chat.ai

import com.dopia.chat.AiMeta

/** Request body of POST /api/v1/chat/turn (AI 5-2). */
data class AiCharacter(
    val name: String,
    val gender: String,
    val personality: String,
    val speechStyle: String,
    val worldSetting: String,
    val isAdult: Boolean,
)

data class AiHistoryItem(
    val role: String,
    val content: String,
)

data class AiGeneration(
    val locale: String,
)

data class AiTurnRequest(
    val character: AiCharacter,
    /** The room's first message. Never part of [history]. */
    val prologue: String,
    val history: List<AiHistoryItem>,
    val summary: String,
    val userInput: String,
    val generation: AiGeneration,
)

class AiFailure(
    val code: String,
    override val message: String,
) : RuntimeException(message)

/** Receives the AI stream. Callbacks run on the turn's executor thread. */
interface AiTurnListener {
    fun onToken(text: String)

    /** Preview only: the web stream should be closed now while generation continues. */
    fun onWebDisconnectRequested() {}

    /** Returns false when generation should stop (turn finished elsewhere). */
    fun stillWanted(): Boolean
}

data class AiTurnResult(
    val output: String,
    val meta: AiMeta,
)

interface AiClient {
    /**
     * Streams a turn; returns the final output or throws AiFailure with the AI's code.
     * [accountId] is the room owner; chat-ai records it as the PostHog distinct_id (AI 5-CONTRACT X-Account-Id).
     */
    fun turn(
        requestId: String,
        accountId: java.util.UUID,
        request: AiTurnRequest,
        characterId: java.util.UUID,
        listener: AiTurnListener,
    ): AiTurnResult
}
