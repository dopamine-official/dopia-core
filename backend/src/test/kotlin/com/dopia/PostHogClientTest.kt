package com.dopia

import com.dopia.common.PostHogClient
import com.dopia.config.AppProperties
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.Test
import tools.jackson.databind.ObjectMapper
import tools.jackson.databind.json.JsonMapper
import java.net.InetSocketAddress
import java.time.Instant
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class PostHogClientTest {
    private fun client(
        host: String,
        key: String = "phc_test",
    ) = PostHogClient(
        AppProperties(posthog = AppProperties.PostHog(apiKey = key, host = host, release = "abc123")),
        JsonMapper(),
    )

    @Test
    fun `sends the event with the account and release, without a location`() {
        val bodies = LinkedBlockingQueue<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/i/v0/e/") { exchange ->
            bodies.add(exchange.requestBody.readAllBytes().decodeToString())
            exchange.sendResponseHeaders(200, -1)
            exchange.close()
        }
        server.start()
        try {
            val account = UUID.randomUUID()
            client("http://127.0.0.1:${server.address.port}").capture(account, "server_logged_out", mapOf("x" to 1), Instant.EPOCH)
            val body = assertNotNull(bodies.poll(5, TimeUnit.SECONDS))
            val json = ObjectMapper().readTree(body)
            assertEquals("phc_test", json.get("api_key").asString())
            assertEquals("server_logged_out", json.get("event").asString())
            assertEquals(account.toString(), json.get("distinct_id").asString())
            assertEquals("1970-01-01T00:00:00Z", json.get("timestamp").asString())
            assertEquals("abc123", json.get("properties").get("app_release").asString())
            assertEquals(1, json.get("properties").get("x").asInt())
            assertEquals(true, json.get("properties").get("\$geoip_disable").asBoolean())
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `without a key nothing is sent`() {
        // Port 1 refuses connections; a send attempt would only log, so this checks no exception.
        client("http://127.0.0.1:1", key = "").capture(UUID.randomUUID(), "e", emptyMap(), Instant.now())
    }
}
