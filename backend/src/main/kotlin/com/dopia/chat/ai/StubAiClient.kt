package com.dopia.chat.ai

import com.dopia.chat.AiMeta
import com.dopia.common.PreviewScenario
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Component
import java.util.UUID

/**
 * Fixed replies until chat-ai exists (TBD 10). Mirrors the web prototype's mock: replies cycle per
 * character and locale, and the preview page can make the next reply slow, fail or disconnect.
 */
@Component
@ConditionalOnProperty(prefix = "app.ai", name = ["mode"], havingValue = "stub", matchIfMissing = true)
class StubAiClient(private val scenario: PreviewScenario) : AiClient {

    override fun turn(
        requestId: String,
        accountId: UUID,
        request: AiTurnRequest,
        characterId: UUID,
        listener: AiTurnListener,
    ): AiTurnResult {
        val behaviour = scenario.takeResponse()
        val replies = StubReplies.of(characterId, request.generation.locale)
        val completedTurns = request.history.count { it.role == "assistant" } - 1
        val reply = replies[maxOf(0, completedTurns) % replies.size]
        val totalMs = if (behaviour == "slow") 6500L else 2200L
        val started = System.currentTimeMillis()
        var position = 0
        var firstTokenAt = 0L
        Thread.sleep(300)
        while (System.currentTimeMillis() - started < totalMs) {
            if (!listener.stillWanted()) throw AiFailure("ai_unavailable", "turn no longer wanted")
            Thread.sleep(65)
            val progress = ((System.currentTimeMillis() - started - 300).toDouble() / (totalMs - 300)).coerceIn(0.0, 1.0)
            val next = (reply.length * progress).toInt()
            if (next > position && behaviour != "fail") {
                if (firstTokenAt == 0L) firstTokenAt = System.currentTimeMillis()
                listener.onToken(reply.substring(position, next))
                position = next
            }
            if (behaviour == "disconnect" && progress > 0.25) {
                listener.onWebDisconnectRequested()
            }
        }
        if (behaviour == "fail") throw AiFailure("mock_response_failed", "Prepared failure scenario")
        val now = System.currentTimeMillis()
        return AiTurnResult(
            output = reply,
            meta = AiMeta(
                model = "stub", provider = "stub", promptVersion = "stub_v1",
                inputTokenCount = null, outputTokenCount = null,
                ttftMs = (firstTokenAt - started).toInt().coerceAtLeast(0),
                generationMs = (now - firstTokenAt).toInt().coerceAtLeast(0),
            ),
        )
    }
}
