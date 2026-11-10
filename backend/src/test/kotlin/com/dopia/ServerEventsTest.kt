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
import java.time.LocalDate
import java.time.Period
import java.time.ZoneId
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

        /** Session set outside HTTP: the login transaction runs in-process. */
        var session: String? = null

        /** A new guest (agreed to the terms) logged in as a fresh member of its own. */
        fun login(): String {
            val guest = json("POST", "/account/guest").get("account_id").asString()
            val (member, token) = accounts.loginFresh(UUID.fromString(guest))
            session = token
            return member
        }

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
                    .apply { session?.let { header("Cookie", "session=$it") } }
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
            // A new guest agrees first, as the web's consent modal makes it (chat needs it).
            if (path ==
                "/account/guest"
            ) {
                json(
                    "POST",
                    "/account/me/consents",
                    """{"items":[{"id":"terms","version":"2026-11-10"},{"id":"privacy","version":"2026-11-10"}]}""",
                )
            }
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

    @Test
    fun `account and chat events carry the planned properties`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest").get("account_id").asString()
        assertEquals("first_visit", only(guest, "server_guest_created").properties["reason"])
        assertEquals(403, browser.call("POST", "/chats/open", """{"character_id":"$winter"}""").statusCode())
        assertTrue(named(guest, "server_room_created").isEmpty())

        val member = browser.login()
        val login = only(member, "server_login_succeeded").properties
        assertEquals("google", login["provider"])
        assertEquals(true, login["is_new_member"])
        assertEquals(true, login["had_guest"])
        assertTrue("merge_scheduled" !in login, login.toString())

        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        browser.json("POST", "/chats/open", """{"character_id":"$winter"}""")
        val created = only(member, "server_room_created")
        assertEquals(room, created.properties["room_id"])
        assertEquals(winter, created.properties["character_id"])
        assertEquals(false, created.properties["is_adult"])

        val reply =
            browser.call("POST", "/chats/$room/messages", """{"content":"안녕 😀","client_message_id":"${UUID.randomUUID()}"}""")
        assertTrue(reply.body().contains("event:completed"), reply.body())
        val completed = only(member, "server_turn_completed").properties
        // Characters as people count them: the emoji is one.
        assertEquals(4, completed["user_message_length"])
        assertEquals(room, completed["room_id"])
        assertEquals("credit", completed["charge_type"])
        assertEquals(false, completed["has_summary"])
        assertEquals(1, completed["history_count"])
        assertNotNull(completed["ai_request_id"])
        assertTrue((completed["assistant_message_length"] as Int) > 0)

        // Start from on, so turning it off is a change.
        jdbc
            .sql(
                "UPDATE accounts SET gender = 'male', birth_date = DATE '1990-01-01', " +
                    "adult_verified_at = now(), adult_mode = true WHERE id = :id",
            ).param("id", UUID.fromString(member))
            .update()
        browser.json("PATCH", "/account/me/adult_mode", """{"adult_mode":false}""")
        assertEquals(false, only(member, "server_safe_mode_changed").properties["adult_mode"])
        // The same value again (a stale second tab) changes nothing.
        browser.json("PATCH", "/account/me/adult_mode", """{"adult_mode":false}""")
        only(member, "server_safe_mode_changed")

        assertTrue(browser.call("DELETE", "/chats/$room").statusCode() in 200..299)
        val deleted = only(member, "server_room_deleted").properties
        assertEquals(room, deleted["room_id"])
        assertEquals(winter, deleted["character_id"])

        val next = browser.json("POST", "/account/logout").get("account_id").asString()
        browser.session = null
        only(member, "server_logged_out")
        assertEquals("logout", only(next, "server_guest_created").properties["reason"])
    }

    @Test
    fun `failed replies, refusals and withdrawal`() {
        val browser = Browser()
        val member = browser.login()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        browser.json("PUT", "/mock/scenario", """{"response":"fail","home":"normal"}""")
        browser.call("POST", "/chats/$room/messages", """{"content":"실패","client_message_id":"${UUID.randomUUID()}"}""")
        val failed = only(member, "server_turn_failed").properties
        assertEquals("mock_response_failed", failed["error_code"])
        assertEquals("before_ai", failed["stage"])
        assertEquals(false, failed["refunded"])
        assertEquals(2, failed["user_message_length"])

        val next = browser.json("POST", "/account/withdraw").get("account_id").asString()
        browser.session = null
        assertEquals(0L, only(member, "server_withdrawn").properties["days_since_created"])
        assertEquals("withdraw", only(next, "server_guest_created").properties["reason"])
    }

    @Test
    fun `a send while a reply is being generated is refused`() {
        val browser = Browser()
        val member = browser.login()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        val first =
            java.util.concurrent.CompletableFuture.supplyAsync {
                browser.call("POST", "/chats/$room/messages", """{"content":"하나","client_message_id":"${UUID.randomUUID()}"}""")
            }
        Thread.sleep(800)
        val second = browser.call("POST", "/chats/$room/messages", """{"content":"둘","client_message_id":"${UUID.randomUUID()}"}""")
        assertEquals(409, second.statusCode())
        first.get()
        val refused = only(member, "server_turn_rejected").properties
        assertEquals("generation_in_progress", refused["code"])
        assertEquals(room, refused["room_id"])
        assertEquals(winter, refused["character_id"])
    }

    @Test
    fun `the preview event list reads every event, unknown values left out`() {
        val browser = Browser()
        val member = browser.login()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        browser.call("POST", "/chats/$room/messages", """{"content":"안녕","client_message_id":"${UUID.randomUUID()}"}""")
        // The stub reports no token counts: left out instead of null.
        val completed = only(member, "server_turn_completed").properties
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
    fun `a reply whose worker went silent is failed as worker_lost`() {
        val browser = Browser()
        val member = browser.login()
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
        val failed = only(member, "server_turn_failed").properties
        assertEquals("worker_lost", failed["stage"])
        assertEquals("worker_lost", failed["error_code"])
        assertEquals(room, failed["room_id"])
        assertEquals(2, failed["user_message_length"])
    }

    @Test
    fun `consent and adult verification events set the person properties`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest").get("account_id").asString()
        val consented = only(guest, "server_consents_recorded")
        assertEquals(listOf("terms", "privacy"), consented.properties["items"])
        assertEquals(true, consented.properties["is_guest"])
        // A consent sets only the consent versions.
        assertEquals(
            mapOf("consent_terms_version" to "2026-11-10", "consent_privacy_version" to "2026-11-10"),
            consented.person,
        )
        // Agreeing again records nothing new.
        browser.json(
            "POST",
            "/account/me/consents",
            """{"items":[{"id":"terms","version":"2026-11-10"},{"id":"privacy","version":"2026-11-10"}]}""",
        )
        only(guest, "server_consents_recorded")

        val (member, token) = accounts.loginFresh(UUID.fromString(guest))
        browser.session = token
        // The guest's consents were copied: the member's person has them from the login on.
        val loginPerson = only(member, "server_login_succeeded").person
        assertEquals("2026-11-10", loginPerson["consent_terms_version"])
        assertEquals(false, loginPerson["adult_verified"])

        val birth = LocalDate.of(1990, 5, 5)
        browser.json("POST", "/account/me/adult_verification", """{"gender":"male","birth_date":"$birth"}""")
        val age = Period.between(birth, LocalDate.now(ZoneId.of("Asia/Taipei"))).years
        val submitted = only(member, "server_adult_verification_submitted")
        assertEquals(mapOf("result" to "passed", "gender" to "male", "age" to age), submitted.properties)
        assertEquals(
            // Only what the verification changed, with the event's own age.
            mapOf(
                "adult_verification_result" to "passed",
                "adult_verified" to true,
                "gender" to "male",
                "age" to age,
            ),
            submitted.person,
        )
        // Passing turned adult mode on.
        assertEquals(true, only(member, "server_safe_mode_changed").properties["adult_mode"])

        val young = Browser()
        val minor = young.login()
        val underage = LocalDate.now(ZoneId.of("Asia/Taipei")).minusYears(17)
        young.json("POST", "/account/me/adult_verification", """{"gender":"female","birth_date":"$underage"}""")
        val rejected = only(minor, "server_adult_verification_submitted")
        assertEquals("rejected", rejected.properties["result"])
        assertEquals("rejected", rejected.person["adult_verification_result"])
        assertEquals(false, rejected.person["adult_verified"])
        assertTrue(named(minor, "server_safe_mode_changed").isEmpty())
        // A second submission is refused and records nothing.
        assertEquals(
            409,
            young.call("POST", "/account/me/adult_verification", """{"gender":"female","birth_date":"1990-01-01"}""").statusCode(),
        )
        only(minor, "server_adult_verification_submitted")
    }
}
