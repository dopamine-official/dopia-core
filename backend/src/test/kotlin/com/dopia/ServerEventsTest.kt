package com.dopia

import com.dopia.account.AccountService
import com.dopia.chat.ChatService
import com.dopia.common.AppEvent
import com.dopia.common.AppEvents
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.test.context.ActiveProfiles
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.net.CookieManager
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Server events (TRACKING-PLAN 8) with their properties, read from the recorder. */
@Import(TestcontainersConfiguration::class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("dev")
class ServerEventsTest(
    @LocalServerPort private val port: Int,
    @Autowired private val events: AppEvents,
    @Autowired private val jdbc: JdbcClient,
    @Autowired private val accounts: AccountService,
    @Autowired private val chat: ChatService,
) {
    private val mapper = ObjectMapper()
    private val winter = "3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d"

    private inner class Browser {
        private val client = HttpClient.newBuilder().cookieHandler(CookieManager()).build()

        fun call(
            method: String,
            path: String,
            body: String? = null,
            type: String = "application/json",
        ): HttpResponse<String> {
            val request =
                HttpRequest
                    .newBuilder(URI("http://127.0.0.1:$port/api/v1$path"))
                    .header("X-Locale", "ko-KR")
                    .method(method, body?.let { HttpRequest.BodyPublishers.ofString(it) } ?: HttpRequest.BodyPublishers.noBody())
                    .apply { if (body != null) header("Content-Type", type) }
                    .build()
            return client.send(request, HttpResponse.BodyHandlers.ofString())
        }

        fun json(
            method: String,
            path: String,
            body: String? = null,
        ): JsonNode {
            val response = call(method, path, body)
            assertTrue(response.statusCode() in 200..299, "$method $path -> ${response.statusCode()} ${response.body()}")
            return mapper.readTree(response.body())
        }
    }

    private fun named(
        account: String,
        name: String,
    ): List<AppEvent> = events.forAccount(UUID.fromString(account)).filter { it.name == name }

    private fun only(
        account: String,
        name: String,
    ): AppEvent {
        val found = named(account, name)
        assertEquals(1, found.size, "$name for $account: $found")
        return found.single()
    }

    private fun mergedFrom(
        member: String,
        guest: String,
    ): Map<String, Any?> = named(member, "server_merge_completed").single { it.properties["guest_account_id"] == guest }.properties

    @Test
    fun `account and chat events carry the planned properties`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest").get("account_id").asString()
        assertEquals("first_visit", only(guest, "server_guest_created").properties["reason"])

        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        browser.json("POST", "/chats/open", """{"character_id":"$winter"}""")
        val created = only(guest, "server_room_created")
        assertEquals(room, created.properties["room_id"])
        assertEquals(winter, created.properties["character_id"])
        assertEquals(false, created.properties["is_adult"])

        val reply =
            browser.call("POST", "/chats/$room/messages", """{"content":"안녕 😀","client_message_id":"${UUID.randomUUID()}"}""")
        assertTrue(reply.body().contains("event:completed"), reply.body())
        val completed = only(guest, "server_turn_completed").properties
        // Characters as people count them: the emoji is one.
        assertEquals(4, completed["user_message_length"])
        assertEquals(room, completed["room_id"])
        assertEquals("free_turn", completed["charge_type"])
        assertEquals(false, completed["has_summary"])
        assertEquals(1, completed["history_count"])
        assertNotNull(completed["ai_request_id"])
        assertTrue((completed["assistant_message_length"] as Int) > 0)

        val member = browser.json("POST", "/mock/login", """{"provider":"apple"}""").get("account_id").asString()
        // Other tests log in as the same mock member: the newest is this login.
        val login = named(member, "server_login_succeeded").first().properties
        assertEquals("apple", login["provider"])
        assertEquals(true, login["had_guest"])
        assertEquals(true, login["merge_scheduled"])
        val merged = mergedFrom(member, guest)
        assertEquals(1, merged["room_count"])
        assertEquals(1, merged["attempt"])

        browser.json("PATCH", "/account/me/adult_mode", """{"adult_mode":false}""")
        assertEquals(false, only(member, "server_safe_mode_changed").properties["adult_mode"])

        assertTrue(browser.call("DELETE", "/chats/$room").statusCode() in 200..299)
        val deleted = only(member, "server_room_deleted").properties
        assertEquals(room, deleted["room_id"])
        assertEquals(winter, deleted["character_id"])

        val next = browser.json("POST", "/account/logout").get("account_id").asString()
        only(member, "server_logged_out")
        assertEquals("logout", only(next, "server_guest_created").properties["reason"])
    }

    @Test
    fun `failed replies, refusals and withdrawal`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest").get("account_id").asString()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        browser.json("PUT", "/mock/scenario", """{"response":"fail","home":"normal"}""")
        browser.call("POST", "/chats/$room/messages", """{"content":"실패","client_message_id":"${UUID.randomUUID()}"}""")
        val failed = only(guest, "server_turn_failed").properties
        assertEquals("mock_response_failed", failed["error_code"])
        assertEquals("before_ai", failed["stage"])
        assertEquals(false, failed["refunded"])
        assertEquals(2, failed["user_message_length"])

        val member = browser.json("POST", "/mock/login", """{"provider":"google"}""").get("account_id").asString()
        val next = browser.json("POST", "/account/withdraw").get("account_id").asString()
        assertEquals(0L, only(member, "server_withdrawn").properties["days_since_created"])
        assertEquals("withdraw", only(next, "server_guest_created").properties["reason"])
    }

    @Test
    fun `a send while a reply is being generated is refused`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest").get("account_id").asString()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        val first =
            java.util.concurrent.CompletableFuture.supplyAsync {
                browser.call("POST", "/chats/$room/messages", """{"content":"하나","client_message_id":"${UUID.randomUUID()}"}""")
            }
        Thread.sleep(800)
        val second = browser.call("POST", "/chats/$room/messages", """{"content":"둘","client_message_id":"${UUID.randomUUID()}"}""")
        assertEquals(409, second.statusCode())
        first.get()
        val refused = only(guest, "server_turn_rejected").properties
        assertEquals("generation_in_progress", refused["code"])
        assertEquals(room, refused["room_id"])
        assertEquals(winter, refused["character_id"])
    }

    @Test
    fun `the preview event list reads every event, unknown values left out`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest").get("account_id").asString()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        browser.call("POST", "/chats/$room/messages", """{"content":"안녕","client_message_id":"${UUID.randomUUID()}"}""")
        // The stub reports no token counts: left out instead of null.
        val completed = only(guest, "server_turn_completed").properties
        assertTrue("input_token_count" !in completed && "output_token_count" !in completed, completed.toString())
        val listed = browser.json("GET", "/mock/events")
        assertTrue(listed.any { it.get("name").asString() == "server_turn_completed" })
        for (event in listed) {
            for (value in event.get("properties").values()) assertTrue(!value.isNull, event.toString())
        }
    }

    @Test
    fun `profile save says what changed`() {
        val browser = Browser()
        browser.json("POST", "/account/guest")
        val member = browser.json("POST", "/mock/login", """{"provider":"google"}""").get("account_id").asString()
        val boundary = "e2e-boundary"
        val form = "--$boundary\r\nContent-Disposition: form-data; name=\"nickname\"\r\n\r\n기록 확인 ${UUID.randomUUID()}\r\n--$boundary--\r\n"
        val saved = browser.call("PATCH", "/account/me", form, "multipart/form-data; boundary=$boundary")
        assertEquals(200, saved.statusCode(), saved.body())
        assertEquals("nickname", named(member, "server_profile_updated").first().properties["changed"])
    }

    @Test
    fun `a guest cookie already gone to a member gets a new guest, blocked`() {
        val first = HttpClient.newHttpClient()
        val issued =
            first.send(
                HttpRequest
                    .newBuilder(URI("http://127.0.0.1:$port/api/v1/account/guest"))
                    .POST(HttpRequest.BodyPublishers.noBody())
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )
        val cookie =
            issued
                .headers()
                .allValues("set-cookie")
                .first { it.startsWith("guest_id=") }
                .substringBefore(';')

        fun withCookie(
            method: String,
            path: String,
            body: String?,
        ): HttpResponse<String> =
            first.send(
                HttpRequest
                    .newBuilder(URI("http://127.0.0.1:$port/api/v1$path"))
                    .header("Cookie", cookie)
                    .header("Content-Type", "application/json")
                    .method(method, body?.let { HttpRequest.BodyPublishers.ofString(it) } ?: HttpRequest.BodyPublishers.noBody())
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )
        assertEquals(200, withCookie("POST", "/mock/login", """{"provider":"apple"}""").statusCode())
        // The same guest cookie again, without the member's session.
        val again = withCookie("POST", "/account/guest", null)
        val next = mapper.readTree(again.body()).get("account_id").asString()
        assertEquals("merged_guest_blocked", only(next, "server_guest_created").properties["reason"])
    }

    @Test
    fun `a reply whose worker went silent is failed as worker_lost`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest").get("account_id").asString()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        browser.json("PUT", "/mock/scenario", """{"response":"slow","home":"normal"}""")
        val sending =
            java.util.concurrent.CompletableFuture.supplyAsync {
                browser.call("POST", "/chats/$room/messages", """{"content":"멈춤","client_message_id":"${UUID.randomUUID()}"}""")
            }
        Thread.sleep(1000)
        jdbc
            .sql("UPDATE chat_turns SET heartbeat_at = now() - interval '1 hour' WHERE room_id = :room AND status = 'generating'")
            .param("room", UUID.fromString(room))
            .update()
        chat.recoverLostTurns()
        sending.get()
        val failed = only(guest, "server_turn_failed").properties
        assertEquals("worker_lost", failed["stage"])
        assertEquals("worker_lost", failed["error_code"])
        assertEquals(room, failed["room_id"])
        assertEquals(2, failed["user_message_length"])
    }

    @Test
    fun `a merge that fails is recorded per attempt, then completes`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest").get("account_id").asString()
        browser.json("POST", "/chats/open", """{"character_id":"$winter"}""")
        // Moving this guest's rooms fails until the trigger is dropped.
        jdbc
            .sql(
                """
            CREATE OR REPLACE FUNCTION test_block_transfer() RETURNS trigger AS $$
            BEGIN
              IF OLD.owner_account_id = '$guest'::uuid THEN RAISE EXCEPTION 'blocked for test'; END IF;
              RETURN NEW;
            END $$ LANGUAGE plpgsql
            """,
            ).update()
        jdbc.sql("CREATE TRIGGER test_block BEFORE UPDATE ON chat_rooms FOR EACH ROW EXECUTE FUNCTION test_block_transfer()").update()
        try {
            val member = browser.json("POST", "/mock/login", """{"provider":"apple"}""").get("account_id").asString()
            runCatching { accounts.merge(UUID.fromString(guest)) }
            val failures = named(member, "server_merge_failed").filter { it.properties["guest_account_id"] == guest }
            assertTrue(failures.size >= 2, failures.toString())
            assertEquals(listOf(1, 2), failures.reversed().take(2).map { it.properties["attempt"] })
            jdbc.sql("DROP TRIGGER test_block ON chat_rooms").update()
            accounts.merge(UUID.fromString(guest))
            val completed = mergedFrom(member, guest)
            // Counted after the fact: the scheduled retry may have added a failed attempt meanwhile.
            val allFailures = named(member, "server_merge_failed").count { it.properties["guest_account_id"] == guest }
            assertEquals(allFailures + 1, completed["attempt"])
            assertEquals(1, completed["room_count"])
        } finally {
            jdbc.sql("DROP TRIGGER IF EXISTS test_block ON chat_rooms").update()
            jdbc.sql("DROP FUNCTION IF EXISTS test_block_transfer()").update()
        }
    }
}
