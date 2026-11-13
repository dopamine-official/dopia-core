package com.dopia

import com.dopia.chat.ai.AiCharacter
import com.dopia.chat.ai.AiFailure
import com.dopia.chat.ai.AiGeneration
import com.dopia.chat.ai.AiStatusWindow
import com.dopia.chat.ai.AiTurnListener
import com.dopia.chat.ai.AiTurnRequest
import com.dopia.chat.ai.HttpAiClient
import com.dopia.config.AppProperties
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import tools.jackson.databind.PropertyNamingStrategies
import tools.jackson.databind.json.JsonMapper
import java.net.InetSocketAddress
import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** HttpAiClient against a fake chat-ai: request headers (BE-09) and stopping a turn mid-stream. */
class HttpAiClientTest {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val headers = ConcurrentHashMap<String, String>()
    private val bodies = java.util.concurrent.CopyOnWriteArrayList<String>()
    private val serverSawDisconnect = CountDownLatch(1)
    private val mapper = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build()

    /** Streams [tokens] tokens [gapMs] apart, then a completed event. */
    private fun serve(
        tokens: Int,
        gapMs: Long,
    ) {
        server.createContext("/api/v1/chat/turn") { exchange ->
            exchange.requestHeaders.forEach { (k, v) -> headers[k.lowercase()] = v.first() }
            bodies += String(exchange.requestBody.readAllBytes())
            exchange.responseHeaders.add("Content-Type", "text/event-stream")
            exchange.sendResponseHeaders(200, 0)
            try {
                exchange.responseBody.use { out ->
                    repeat(tokens) {
                        out.write("event: token\ndata: {\"text\":\"t$it\"}\n\n".toByteArray())
                        out.flush()
                        Thread.sleep(gapMs)
                    }
                    out.write(
                        (
                            "event: completed\ndata: {\"output\":\"done\",\"meta\":{\"model\":\"m\",\"provider\":\"p\"," +
                                "\"prompt_version\":\"chat_v1\",\"ttft_ms\":5}}\n\n"
                        ).toByteArray(),
                    )
                }
            } catch (_: java.io.IOException) {
                serverSawDisconnect.countDown()
            }
        }
        server.start()
    }

    private fun client() =
        HttpAiClient(
            AppProperties(
                ai = AppProperties.Ai(mode = "http", baseUrl = "http://127.0.0.1:${server.address.port}", timeout = Duration.ofSeconds(30)),
            ),
            mapper,
        )

    private val request =
        AiTurnRequest(
            character = AiCharacter("A", "f", "p", "s", "w", false),
            prologue = "opening",
            history = emptyList(),
            summary = "",
            userInput = "hi",
            generation = AiGeneration("ko-KR"),
        )

    @AfterEach
    fun stop() = server.stop(0)

    @Test
    fun `BE-09 sends request id and the room owner as account id`() {
        serve(tokens = 2, gapMs = 0)
        val account = UUID.randomUUID()
        val tokens = mutableListOf<String>()
        val result =
            client().turn(
                "req-123",
                account,
                request,
                UUID.randomUUID(),
                object : AiTurnListener {
                    override fun onToken(text: String) {
                        tokens += text
                    }

                    override fun stillWanted() = true
                },
            )
        assertEquals("req-123", headers["x-request-id"])
        assertEquals(account.toString(), headers["x-account-id"])
        val sent = mapper.readTree(bodies.single())
        assertEquals("opening", sent.get("prologue").asString())
        assertEquals(0, sent.get("history").size())
        assertEquals("hi", sent.get("user_input").asString())
        // A character with the status window off: the object is left out, not sent as null.
        assertEquals(false, sent.get("character").has("status_window"))
        assertEquals(listOf("t0", "t1"), tokens)
        assertEquals("done", result.output)
        assertEquals("chat_v1", result.meta.promptVersion)
    }

    @Test
    fun `status window settings are sent with the character when it has them`() {
        serve(tokens = 1, gapMs = 0)
        val withWindow = request.copy(character = request.character.copy(statusWindow = AiStatusWindow("Stage: <stage>", "slow")))
        client().turn(
            "req-status",
            UUID.randomUUID(),
            withWindow,
            UUID.randomUUID(),
            object : AiTurnListener {
                override fun onToken(text: String) {}

                override fun stillWanted() = true
            },
        )
        val window = mapper.readTree(bodies.single()).get("character").get("status_window")
        assertEquals("Stage: <stage>", window.get("format").asString())
        assertEquals("slow", window.get("rules").asString())
    }

    @Test
    fun `status window rules are left out when the character has none`() {
        serve(tokens = 1, gapMs = 0)
        val formatOnly = request.copy(character = request.character.copy(statusWindow = AiStatusWindow("Stage: <stage>")))
        client().turn(
            "req-status",
            UUID.randomUUID(),
            formatOnly,
            UUID.randomUUID(),
            object : AiTurnListener {
                override fun onToken(text: String) {}

                override fun stillWanted() = true
            },
        )
        val window = mapper.readTree(bodies.single()).get("character").get("status_window")
        assertEquals("Stage: <stage>", window.get("format").asString())
        assertEquals(false, window.has("rules"))
    }

    @Test
    fun `stopping a turn closes the connection instead of reading the rest`() {
        // 40 tokens 100 ms apart: reading to the end would take 4 s.
        serve(tokens = 40, gapMs = 100)
        var seen = 0
        val started = System.nanoTime()
        assertFailsWith<AiFailure> {
            client().turn(
                "req-stop",
                UUID.randomUUID(),
                request,
                UUID.randomUUID(),
                object : AiTurnListener {
                    override fun onToken(text: String) {
                        seen++
                    }

                    override fun stillWanted() = seen < 1
                },
            )
        }
        val elapsedMs = Duration.ofNanos(System.nanoTime() - started).toMillis()
        assertTrue(elapsedMs < 1500, "turn() returned after $elapsedMs ms; it read the stream to the end")
        // chat-ai must see the disconnect so it can cancel the provider call.
        assertTrue(serverSawDisconnect.await(3, TimeUnit.SECONDS), "server never saw the connection close")
    }
}
