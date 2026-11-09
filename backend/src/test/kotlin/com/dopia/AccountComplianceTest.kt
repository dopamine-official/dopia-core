package com.dopia

import com.dopia.account.AccountService
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.context.ActiveProfiles
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.net.CookieManager
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Adult verification and consent records (DOMAIN/ACCOUNT/BE 5-5 AC-BE-22 to AC-BE-28) against the
 * TW region config: adult age 18, birth date only, required `terms` and `privacy`.
 */
@Import(TestcontainersConfiguration::class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("dev")
class AccountComplianceTest(
    @LocalServerPort private val port: Int,
    @Autowired private val accounts: AccountService,
    @Autowired private val jdbc: JdbcClient,
) {
    private val mapper = ObjectMapper()
    private val base = "http://127.0.0.1:$port"
    private val consents = """{"items":[{"id":"terms","version":"2026-11-10"},{"id":"privacy","version":"2026-11-10"}]}"""

    private inner class Browser {
        val cookies = CookieManager()
        private val client = HttpClient.newBuilder().cookieHandler(cookies).build()

        /** Session set outside HTTP (the login transaction runs in-process). */
        var session: String? = null

        fun call(
            method: String,
            path: String,
            body: String? = null,
        ): HttpResponse<String> {
            val request =
                HttpRequest
                    .newBuilder(URI("$base/api/v1$path"))
                    .header("X-Region", "TW")
                    .apply { session?.let { header("Cookie", "session=$it") } }
                    .method(method, body?.let { HttpRequest.BodyPublishers.ofString(it) } ?: HttpRequest.BodyPublishers.noBody())
                    .apply { if (body != null) header("Content-Type", "application/json") }
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

        fun code(
            method: String,
            path: String,
            body: String? = null,
        ): Pair<Int, String?> {
            val response = call(method, path, body)
            val code = runCatching { mapper.readTree(response.body()).get("code")?.asString() }.getOrNull()
            return response.statusCode() to code
        }

        /** Logs this browser in as a fresh member through the real login transaction. */
        fun login(): String {
            val guest = json("POST", "/account/guest").get("account_id").asString()
            val response = MockHttpServletResponse()
            val profile = AccountService.ProviderProfile("google", "compliance-${UUID.randomUUID()}", "Tester ${UUID.randomUUID()}", null)
            val member = accounts.completeLogin(profile, UUID.fromString(guest), response)
            session = response.getCookie("session")!!.value
            return member.toString()
        }
    }

    private fun today() = LocalDate.now(ZoneId.of("Asia/Taipei"))

    private fun verification(
        gender: String,
        birth: LocalDate,
    ) = """{"gender":"$gender","birth_date":"$birth"}"""

    @Test
    fun `adult on the 18th birthday passes and turns adult mode on`() {
        val browser = Browser()
        val member = browser.login()
        val me = browser.json("POST", "/account/me/adult_verification", verification("male", today().minusYears(18)))
        assertTrue(me.get("adult_verified").asBoolean())
        assertTrue(me.get("adult_mode").asBoolean())
        assertFalse(me.get("adult_verification_rejected").asBoolean())
        val stored =
            jdbc
                .sql("SELECT gender, birth_date FROM accounts WHERE id = :id")
                .param("id", UUID.fromString(member))
                .query { rs, _ -> rs.getString("gender") to rs.getObject("birth_date", LocalDate::class.java) }
                .single()
        assertEquals("male" to today().minusYears(18), stored)
        // Never shown back to the web.
        assertFalse(me.has("gender") || me.has("birth_date"))

        val again = browser.code("POST", "/account/me/adult_verification", verification("female", LocalDate.of(1990, 1, 1)))
        assertEquals(409 to "adult_verification_submitted", again)
    }

    @Test
    fun `one day short of 18 is rejected, stored and cannot be resubmitted`() {
        val browser = Browser()
        browser.login()
        val me = browser.json("POST", "/account/me/adult_verification", verification("female", today().minusYears(18).plusDays(1)))
        assertFalse(me.get("adult_verified").asBoolean())
        assertFalse(me.get("adult_mode").asBoolean())
        assertTrue(me.get("adult_verification_rejected").asBoolean())
        assertEquals(
            409 to "adult_verification_submitted",
            browser.code("POST", "/account/me/adult_verification", verification("female", LocalDate.of(1990, 1, 1))),
        )
        assertEquals(403 to "adult_verification_required", browser.code("PATCH", "/account/me/adult_mode", """{"adult_mode":true}"""))
    }

    @Test
    fun `concurrent submissions store one`() {
        val browser = Browser()
        browser.login()
        val pool = Executors.newFixedThreadPool(2)
        try {
            val body = verification("male", LocalDate.of(1995, 5, 5))
            val results =
                pool
                    .invokeAll(List(2) { Callable { browser.call("POST", "/account/me/adult_verification", body).statusCode() } })
                    .map { it.get() }
                    .sorted()
            assertEquals(listOf(200, 409), results)
        } finally {
            pool.shutdown()
        }
    }

    @Test
    fun `invalid submissions and guests change nothing`() {
        val guest = Browser()
        guest.json("POST", "/account/guest")
        assertEquals(
            403 to "member_required",
            guest.code("POST", "/account/me/adult_verification", verification("male", LocalDate.of(1990, 1, 1))),
        )

        val browser = Browser()
        val member = browser.login()
        for (body in listOf(
            verification("other", LocalDate.of(1990, 1, 1)),
            verification("male", today().plusDays(1)),
            verification("male", LocalDate.of(1899, 12, 31)),
            """{"gender":"male","birth_date":"2026-02-30"}""",
            """{"gender":"male"}""",
        )) {
            assertEquals(422 to "invalid_input", browser.code("POST", "/account/me/adult_verification", body), body)
        }
        val untouched =
            jdbc
                .sql("SELECT birth_date IS NULL FROM accounts WHERE id = :id")
                .param("id", UUID.fromString(member))
                .query(Boolean::class.java)
                .single()
        assertTrue(untouched)
    }

    @Test
    fun `consents gate on the current required versions`() {
        val browser = Browser()
        browser.json("POST", "/account/guest")
        assertTrue(browser.json("GET", "/account/me").get("consent_required").asBoolean())
        assertEquals(
            422 to "invalid_input",
            browser.code("POST", "/account/me/consents", """{"items":[{"id":"terms","version":"2026-11-10"}]}"""),
        )
        assertEquals(
            422 to "invalid_input",
            browser.code(
                "POST",
                "/account/me/consents",
                """{"items":[{"id":"terms","version":"2000-01-01"},{"id":"privacy","version":"2026-11-10"}]}""",
            ),
        )
        assertEquals(
            422 to "invalid_input",
            browser.code(
                "POST",
                "/account/me/consents",
                """{"items":[{"id":"unknown","version":"1"},{"id":"terms","version":"2026-11-10"},{"id":"privacy","version":"2026-11-10"}]}""",
            ),
        )
        assertTrue(browser.json("GET", "/account/me").get("consent_required").asBoolean())
        assertFalse(browser.json("POST", "/account/me/consents", consents).get("consent_required").asBoolean())
        // Agreeing again keeps the first record.
        assertFalse(browser.json("POST", "/account/me/consents", consents).get("consent_required").asBoolean())
    }

    @Test
    fun `chat waits for consent while home and the consent items stay readable`() {
        val browser = Browser()
        browser.json("POST", "/account/guest")
        val me = browser.json("GET", "/account/me")
        assertEquals(listOf("terms", "privacy"), me.get("consent_items").values().map { it.get("id").asString() })
        assertEquals(
            "2026-11-10",
            me
                .get("consent_items")
                .get(0)
                .get("version")
                .asString(),
        )
        assertEquals(200, browser.call("GET", "/home").statusCode())
        val open = browser.code("POST", "/chats/open", "{\"character_id\":\"${UUID.randomUUID()}\"}")
        assertEquals(403 to "consent_required", open)
        browser.json("POST", "/account/me/consents", consents)
        assertEquals(404, browser.call("POST", "/chats/open", "{\"character_id\":\"${UUID.randomUUID()}\"}").statusCode())
    }

    @Test
    fun `consents follow login and logout but not withdrawal`() {
        val browser = Browser()
        browser.json("POST", "/account/guest")
        browser.json("POST", "/account/me/consents", consents)
        val guest = browser.json("GET", "/account/me").get("account_id").asString()
        val response = MockHttpServletResponse()
        val profile = AccountService.ProviderProfile("google", "compliance-${UUID.randomUUID()}", "Copy ${UUID.randomUUID()}", null)
        accounts.completeLogin(profile, UUID.fromString(guest), response)
        browser.session = response.getCookie("session")!!.value
        val member = browser.json("GET", "/account/me")
        assertFalse(member.get("is_guest").asBoolean())
        assertFalse(member.get("consent_required").asBoolean())

        browser.json("POST", "/account/logout")
        browser.session = null
        assertFalse(browser.json("GET", "/account/me").get("consent_required").asBoolean())

        val leaving = Browser()
        leaving.login()
        leaving.json("POST", "/account/me/consents", consents)
        leaving.json("POST", "/account/withdraw")
        leaving.session = null
        assertTrue(leaving.json("GET", "/account/me").get("consent_required").asBoolean())
    }
}
