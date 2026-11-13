package com.dopia

import com.dopia.account.AccountService
import com.dopia.character.CharacterService
import com.dopia.character.StatusWindow
import com.dopia.chat.ChatRepository
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.dao.DataIntegrityViolationException
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
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** End-to-end contract checks over HTTP against a throwaway PostgreSQL (Testcontainers). */
@Import(TestcontainersConfiguration::class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("dev")
class ChatFlowTest(
    @LocalServerPort private val port: Int,
    @Autowired private val accounts: AccountService,
    @Autowired private val chats: ChatRepository,
    @Autowired private val characters: CharacterService,
    @Autowired private val jdbc: JdbcClient,
) {
    private val mapper = ObjectMapper()
    private val winter = "3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d"

    /** One browser: its own cookie jar. */
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
            locale: String = "ko-KR",
        ): HttpResponse<String> {
            val request =
                HttpRequest
                    .newBuilder(URI("http://127.0.0.1:$port/api/v1$path"))
                    .header("X-Locale", locale)
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
            locale: String = "ko-KR",
        ): JsonNode {
            val response = call(method, path, body, locale = locale)
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

    private fun send(
        browser: Browser,
        room: String,
        content: String,
        clientId: String = UUID.randomUUID().toString(),
    ): HttpResponse<String> = browser.call("POST", "/chats/$room/messages", """{"content":"$content","client_message_id":"$clientId"}""")

    @Test
    fun `a guest browses but cannot chat, a member chats and an idempotent resend replays the reply`() {
        val browser = Browser()
        val guest = browser.json("POST", "/account/guest")
        val guestId = guest.get("account_id").asString()
        assertTrue(browser.json("GET", "/account/me").get("is_guest").asBoolean())

        val home = browser.json("GET", "/home")
        assertEquals(
            "오리지널",
            home
                .get("sections")
                .get(0)
                .get("name")
                .asString(),
        )
        assertEquals(
            "Winter",
            browser
                .json("GET", "/home", locale = "en-US")
                .get("sections")
                .get(0)
                .get("characters")
                .get(1)
                .get("name")
                .asString(),
        )

        // Chat is for members: no room for a guest, and a guest has no rooms to list.
        val refused = browser.call("POST", "/chats/open", """{"character_id":"$winter"}""")
        assertEquals(403, refused.statusCode())
        assertEquals("member_required", mapper.readTree(refused.body()).get("code").asString())
        assertEquals(0, browser.json("GET", "/chats/recent").get("chats").size())

        val member = browser.login()
        assertEquals(false, browser.json("GET", "/account/me").get("is_guest").asBoolean())
        assertNotEquals(guestId, member)

        val opened = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""")
        val room = opened.get("room_id").asString()
        assertEquals(room, browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString())

        val clientId = UUID.randomUUID().toString()
        val stream = send(browser, room, "안녕", clientId)
        assertEquals(200, stream.statusCode())
        assertTrue(
            stream
                .headers()
                .firstValue("content-type")
                .orElse("")
                .startsWith("text/event-stream"),
        )
        assertTrue(stream.body().contains("event:accepted"))
        assertTrue(stream.body().contains("event:completed"))

        val view = browser.json("GET", "/chats/$room")
        assertEquals(3, view.get("messages").size())
        assertEquals(
            "completed",
            view
                .get("messages")
                .get(1)
                .get("turn_status")
                .asString(),
        )
        assertEquals(false, view.get("generating").asBoolean())

        // Same key and text: stored result, no new turn. Same key, other text: 422.
        val replay = send(browser, room, "안녕", clientId)
        assertTrue(replay.body().contains("event:completed"))
        assertEquals(3, browser.json("GET", "/chats/$room").get("messages").size())
        val mismatch = send(browser, room, "다른 내용", clientId)
        assertEquals(422, mismatch.statusCode())
        assertEquals(
            "client_message_id",
            mapper
                .readTree(mismatch.body())
                .get("detail")
                .get(0)
                .get("field")
                .asString(),
        )

        assertEquals(
            room,
            browser
                .json("GET", "/chats/recent")
                .get("chats")
                .get(0)
                .get("room_id")
                .asString(),
        )

        // Multipart profile edits are covered by the web E2E suite.

        val loggedOut = browser.json("POST", "/account/logout")
        browser.session = null
        assertNotEquals(member, loggedOut.get("account_id").asString())
        assertEquals(404, browser.call("GET", "/chats/$room").statusCode())
        assertEquals(403, browser.call("POST", "/account/logout").statusCode())
    }

    @Test
    fun `unknown cookies are 401 and invalid ids are 422`() {
        val browser = Browser()
        assertEquals(401, browser.call("GET", "/account/me").statusCode())
        browser.login()
        assertEquals(422, browser.call("POST", "/chats/open", """{"character_id":"nope"}""").statusCode())
        assertEquals(404, browser.call("POST", "/chats/open", """{"character_id":"${UUID.randomUUID()}"}""").statusCode())
        assertEquals(422, browser.call("DELETE", "/chats/not-a-uuid").statusCode())
        browser.json("POST", "/account/logout")
        browser.session = null
        val adult = browser.call("PATCH", "/account/me/adult_mode", """{"adult_mode":true}""")
        assertEquals(403, adult.statusCode())
        assertEquals("adult_verification_required", mapper.readTree(adult.body()).get("code").asString())
    }

    @Test
    fun `BE-09 the first message goes to the AI as the prologue, not as history`() {
        val browser = Browser()
        browser.login()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        val roomId = UUID.fromString(room)
        val firstMessage =
            browser
                .json("GET", "/chats/$room")
                .get("messages")
                .get(0)
                .get("content")
                .asString()
        assertEquals(firstMessage, chats.prologueOf(roomId))
        // A new room: nothing has been exchanged yet.
        assertEquals(emptyList(), chats.historyAfter(roomId, 0, Int.MAX_VALUE))

        assertTrue(send(browser, room, "하나").body().contains("event:completed"))
        browser.json("PUT", "/mock/scenario", """{"response":"fail","home":"normal"}""")
        assertTrue(send(browser, room, "실패").body().contains("event:failed"))
        assertTrue(send(browser, room, "둘").body().contains("event:completed"))

        // Completed turns only, starting with the user; the first message and the failed turn are left out.
        val history = chats.historyAfter(roomId, 0, Int.MAX_VALUE)
        assertEquals(listOf("user", "assistant", "user", "assistant"), history.map { it.role })
        assertEquals(listOf("하나", "둘"), history.filter { it.role == "user" }.map { it.content })
        assertTrue(history.none { it.content == firstMessage })
        assertEquals(firstMessage, chats.prologueOf(roomId))
    }

    @Test
    fun `status window settings reach chat only while the creator has it turned on`() {
        fun character(
            enabled: Boolean,
            format: String,
            rules: String,
        ): UUID {
            val id = UUID.randomUUID()
            jdbc
                .sql(
                    """
                    INSERT INTO characters (id, source_locale, name, tagline, first_message, personality, speech_style,
                                            world_setting, gender, image_url, creator_name, is_public,
                                            status_window_enabled, status_window_format, status_window_rules)
                    VALUES (:id, 'ko-KR', '{"ko-KR": "n"}', '{"ko-KR": "t"}', '{"ko-KR": "f"}', '{"ko-KR": "p"}',
                            '{"ko-KR": "s"}', '{"ko-KR": "w"}', 'female', '/images/mock_gray.svg', 'c', false,
                            :enabled, CAST(:format AS jsonb), CAST(:rules AS jsonb))
                    """.trimIndent(),
                ).param("id", id)
                .param("enabled", enabled)
                .param("format", format)
                .param("rules", rules)
                .update()
            return id
        }

        fun window(
            id: UUID,
            locale: String = "ko-KR",
        ) = characters.forChat(id, locale, adultAllowed = false).statusWindow
        val format = """{"ko-KR": " 관계: <단계> "}"""
        val rules = """{"ko-KR": "천천히"}"""

        val on = character(true, format, rules)
        assertEquals(StatusWindow("관계: <단계>", "천천히"), window(on))
        // The texts fall back to the source locale like every other text.
        assertEquals(StatusWindow("관계: <단계>", "천천히"), window(on, "zh-TW"))
        assertEquals(StatusWindow("관계: <단계>", null), window(character(true, format, "{}")))

        // Turned off: what the creator wrote is kept in the row but chat gets nothing.
        assertEquals(null, window(character(false, format, rules)))
        assertEquals(null, window(UUID.fromString(winter)))

        // It cannot be turned on without a format in the language the character was written in.
        assertFailsWith<DataIntegrityViolationException> { character(true, "{}", rules) }
        assertFailsWith<DataIntegrityViolationException> { character(true, """{"zh-TW": "關係"}""", rules) }
    }

    @Test
    fun `the AI gets the character's own name, or the card name when none is set`() {
        val winterId = UUID.fromString(winter)
        // A character made before the column existed has no name of its own.
        val before = characters.forChat(winterId, "ko-KR", adultAllowed = false)
        assertEquals("겨울", before.name)
        assertEquals("겨울", before.characterName)
        try {
            jdbc
                .sql("""UPDATE characters SET character_name = '{"ko-KR": " 한겨울 ", "zh-TW": "韓冬"}' WHERE id = :id""")
                .param("id", winterId)
                .update()
            val after = characters.forChat(winterId, "ko-KR", adultAllowed = false)
            assertEquals("겨울", after.name) // the card still shows its own text
            assertEquals("한겨울", after.characterName)
            assertEquals("韓冬", characters.forChat(winterId, "zh-TW", adultAllowed = false).characterName)
        } finally {
            jdbc.sql("UPDATE characters SET character_name = '{}' WHERE id = :id").param("id", winterId).update()
        }
    }

    @Test
    fun `preview failure scenario stores a failed turn that the history exposes`() {
        val browser = Browser()
        browser.login()
        val room = browser.json("POST", "/chats/open", """{"character_id":"$winter"}""").get("room_id").asString()
        browser.json("PUT", "/mock/scenario", """{"response":"fail","home":"normal"}""")
        val stream = send(browser, room, "실패")
        assertTrue(stream.body().contains("event:failed"), stream.body())
        val messages = browser.json("GET", "/chats/$room").get("messages")
        assertEquals("failed", messages.get(1).get("turn_status").asString())
        assertEquals("mock_response_failed", messages.get(1).get("error_code").asString())
        assertNotNull(
            browser
                .json("GET", "/chats/recent")
                .get("chats")
                .get(0)
                .get("last_message"),
        )
        assertEquals("normal", browser.json("GET", "/mock/scenario").get("response").asString())
    }
}
