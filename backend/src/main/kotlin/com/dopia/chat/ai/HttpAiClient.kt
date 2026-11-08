package com.dopia.chat.ai

import com.dopia.chat.AiMeta
import com.dopia.config.AppProperties
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.MediaType
import org.springframework.http.client.SimpleClientHttpRequestFactory
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import org.springframework.http.converter.json.JacksonJsonHttpMessageConverter
import tools.jackson.databind.json.JsonMapper
import java.io.BufferedReader
import java.util.UUID

/** Real chat-ai over HTTP SSE (AI 5-CONTRACT). Selected with AI_MODE=http. */
@Component
@ConditionalOnProperty(prefix = "app.ai", name = ["mode"], havingValue = "http")
class HttpAiClient(properties: AppProperties, private val mapper: JsonMapper) : AiClient {
    // The app's JsonMapper carries the snake_case setting the AI contract requires.
    // SimpleClientHttpRequestFactory's read timeout is a socket timeout, so it also fires when
    // chat-ai goes silent in the middle of a stream; AI_TIMEOUT is the longest silence we accept.
    private val client = RestClient.builder()
        .baseUrl(properties.ai.baseUrl)
        .requestFactory(
            SimpleClientHttpRequestFactory().apply {
                setConnectTimeout(java.time.Duration.ofSeconds(5))
                setReadTimeout(properties.ai.timeout)
            },
        )
        .messageConverters { converters -> converters.add(0, JacksonJsonHttpMessageConverter(mapper)) }
        .build()

    override fun turn(
        requestId: String,
        accountId: UUID,
        request: AiTurnRequest,
        characterId: UUID,
        listener: AiTurnListener,
    ): AiTurnResult {
        return client.post().uri("/api/v1/chat/turn")
            .contentType(MediaType.APPLICATION_JSON)
            .header("X-Request-Id", requestId)
            .header("X-Account-Id", accountId.toString())
            .accept(MediaType.TEXT_EVENT_STREAM)
            .body(request)
            // The stream is consumed inside the exchange function, so RestClient closes the response
            // (and releases the connection) when it returns or throws.
            .exchange { _, response ->
                if (!response.statusCode.is2xxSuccessful) {
                    val body = runCatching { mapper.readTree(response.body) }.getOrNull()
                    throw AiFailure(body?.path("code")?.asString()?.ifEmpty { null } ?: "ai_unavailable", "ai server returned ${response.statusCode}")
                }
                readStream(response.body.bufferedReader(), listener)
            }
    }

    private fun readStream(reader: BufferedReader, listener: AiTurnListener): AiTurnResult {
        var event: String? = null
        val data = StringBuilder()
        var result: AiTurnResult? = null
        while (true) {
            // Once the turn was ended elsewhere, close the body ourselves before leaving. RestClient's own
            // close on SimpleClientHttpResponse drains the stream to the end first, which would keep the
            // connection open until chat-ai finished generating, so chat-ai would never see a disconnect
            // and the provider call would run (and bill) to completion. Closing a chunked body that is
            // still streaming drops the socket instead.
            if (!listener.stillWanted()) {
                runCatching { reader.close() }
                throw AiFailure("ai_unavailable", "turn no longer wanted")
            }
            val line = reader.readLine() ?: break
            if (line.isEmpty()) {
                if (event != null && data.isNotEmpty()) {
                    val node = mapper.readTree(data.toString())
                    when (event) {
                        "token" -> listener.onToken(node.path("text").asString())
                        "completed" -> {
                            val meta = node.path("meta")
                            result = AiTurnResult(
                                output = node.path("output").asString(),
                                meta = AiMeta(
                                    model = meta.path("model").asString().ifEmpty { null },
                                    provider = meta.path("provider").asString().ifEmpty { null },
                                    promptVersion = meta.path("prompt_version").asString().ifEmpty { null },
                                    inputTokenCount = meta.path("input_token_count").takeIf { it.isNumber }?.asInt(),
                                    outputTokenCount = meta.path("output_token_count").takeIf { it.isNumber }?.asInt(),
                                    ttftMs = meta.path("ttft_ms").takeIf { it.isNumber }?.asInt(),
                                    generationMs = meta.path("generation_ms").takeIf { it.isNumber }?.asInt(),
                                ),
                            )
                        }
                        "failed" -> throw AiFailure(node.path("code").asString().ifEmpty { "ai_unavailable" }, node.path("message").asString())
                    }
                    if (result != null) return result
                }
                event = null
                data.setLength(0)
                continue
            }
            when {
                line.startsWith("event:") -> event = line.substring(6).trim()
                line.startsWith("data:") -> data.append(line.substring(5).trimStart())
            }
        }
        throw AiFailure("ai_unavailable", "stream ended without a terminal event")
    }
}
