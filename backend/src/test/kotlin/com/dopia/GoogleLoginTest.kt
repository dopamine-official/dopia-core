package com.dopia

import com.dopia.common.AppEvents
import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import tools.jackson.databind.ObjectMapper
import java.net.CookieManager
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLDecoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.time.Instant
import java.util.Base64
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Login round trip against a fake Google (AC-BE-03, AC-BE-09) using a test-signed ID token. */
@Import(TestcontainersConfiguration::class)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("dev")
class GoogleLoginTest(
    @LocalServerPort private val port: Int,
    @Autowired private val events: AppEvents,
) {
    private val mapper = ObjectMapper()

    companion object {
        private val base64 = Base64.getUrlEncoder().withoutPadding()
        private val keys: KeyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        private lateinit var fake: HttpServer
        var issuedAudience = "test-client"
        var issuedExp = Instant.now().plusSeconds(600).epochSecond

        private fun jwt(): String {
            val header = base64.encodeToString("""{"alg":"RS256","kid":"test"}""".toByteArray())
            val payload =
                base64.encodeToString(
                    """{"iss":"https://accounts.google.com","aud":"$issuedAudience","sub":"google-sub-1","email":"jane@example.com","name":"Jane Doe","exp":$issuedExp}"""
                        .toByteArray(),
                )
            val signer =
                Signature.getInstance("SHA256withRSA").apply {
                    initSign(keys.private)
                    update("$header.$payload".toByteArray())
                }
            return "$header.$payload.${base64.encodeToString(signer.sign())}"
        }

        @JvmStatic
        @BeforeAll
        fun startFakeGoogle() {
            fake = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            fake.createContext("/certs") { exchange ->
                val public = keys.public as RSAPublicKey
                val body = """{"keys":[{"kty":"RSA","kid":"test","n":"${base64.encodeToString(
                    public.modulus.toByteArray(),
                )}","e":"${base64.encodeToString(public.publicExponent.toByteArray())}"}]}"""
                exchange.sendResponseHeaders(200, body.length.toLong())
                exchange.responseBody.use { it.write(body.toByteArray()) }
            }
            fake.createContext("/token") { exchange ->
                val form = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
                val code =
                    form
                        .split("&")
                        .map { it.split("=") }
                        .firstOrNull { it[0] == "code" }
                        ?.get(1)
                val body = if (code == "good-code") """{"id_token":"${jwt()}","access_token":"x"}""" else """{"error":"invalid_grant"}"""
                exchange.sendResponseHeaders(if (code == "good-code") 200 else 400, body.toByteArray().size.toLong())
                exchange.responseBody.use { it.write(body.toByteArray()) }
            }
            fake.start()
        }

        @JvmStatic
        @AfterAll
        fun stopFakeGoogle() = fake.stop(0)

        @JvmStatic
        @DynamicPropertySource
        fun oauth(registry: DynamicPropertyRegistry) {
            registry.add("app.oauth.google.client_id") { "test-client" }
            registry.add("app.oauth.google.client_secret") { "test-secret" }
            registry.add("app.oauth.google.authorize_url") { "http://127.0.0.1:${fake.address.port}/authorize" }
            registry.add("app.oauth.google.token_url") { "http://127.0.0.1:${fake.address.port}/token" }
            registry.add("app.oauth.google.jwks_url") { "http://127.0.0.1:${fake.address.port}/certs" }
        }
    }

    private inner class Browser {
        private val client =
            HttpClient
                .newBuilder()
                .cookieHandler(CookieManager())
                .followRedirects(HttpClient.Redirect.NEVER)
                .build()

        fun get(path: String): HttpResponse<String> =
            client.send(
                HttpRequest
                    .newBuilder(URI("http://127.0.0.1:$port/api/v1$path"))
                    .header("X-Locale", "ko-KR")
                    .GET()
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )

        fun post(
            path: String,
            body: String,
        ): HttpResponse<String> =
            client.send(
                HttpRequest
                    .newBuilder(
                        URI("http://127.0.0.1:$port/api/v1$path"),
                    ).header("X-Locale", "ko-KR")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )
    }

    private fun stateOf(location: String): String =
        URI(location)
            .rawQuery
            .split("&")
            .map {
                it.split("=", limit = 2)
            }.first { it[0] == "state" }[1]
            .let { URLDecoder.decode(it, Charsets.UTF_8) }

    @Test
    fun `guest logs in with google, keeps rooms, and is sent back to return_to`() {
        val browser = Browser()
        browser.post("/account/guest", "")
        val room =
            mapper
                .readTree(
                    browser.post("/chats/open", """{"character_id":"3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d"}""").body(),
                ).get("room_id")
                .asString()

        val start = browser.get("/account/auth/google/start?return_to=%2Fme")
        assertEquals(302, start.statusCode())
        val location = start.headers().firstValue("location").get()
        assertTrue(location.startsWith("http://127.0.0.1:${fake.address.port}/authorize?"), location)
        assertTrue(
            start.headers().allValues("set-cookie").any { it.startsWith("login_state=") && it.contains("Path=/api/v1/account/auth/") },
        )

        val callback = browser.get("/account/auth/google/callback?code=good-code&state=${stateOf(location)}")
        assertEquals(302, callback.statusCode())
        assertEquals("http://127.0.0.1:3000/me", callback.headers().firstValue("location").get())
        assertTrue(callback.headers().allValues("set-cookie").any { it.startsWith("session=") })
        assertTrue(callback.headers().allValues("set-cookie").any { it.startsWith("login_state=;") })

        val me = mapper.readTree(browser.get("/account/me").body())
        assertEquals(false, me.get("is_guest").asBoolean())
        assertEquals("Jane Doe", me.get("nickname").asString())
        assertEquals(
            room,
            mapper
                .readTree(browser.get("/chats/recent").body())
                .get("chats")
                .get(0)
                .get("room_id")
                .asString(),
        )

        // Already a member: start goes straight back.
        assertEquals(
            "http://127.0.0.1:3000/",
            browser
                .get("/account/auth/google/start")
                .headers()
                .firstValue("location")
                .get(),
        )
    }

    @Test
    fun `wrong state, bad code and cancellation never create a session`() {
        val browser = Browser()
        val guest = UUID.fromString(mapper.readTree(browser.post("/account/guest", "").body()).get("account_id").asString())
        val start = browser.get("/account/auth/google/start?return_to=%2Fchats%2Fx")
        val state = stateOf(start.headers().firstValue("location").get())

        val wrongState = browser.get("/account/auth/google/callback?code=good-code&state=other")
        assertEquals("http://127.0.0.1:3000/chats/x?login=1&error=login_failed", wrongState.headers().firstValue("location").get())
        assertTrue(
            wrongState
                .headers()
                .firstValue("location")
                .get()
                .contains("error=login_failed"),
        )

        browser.get("/account/auth/google/start?return_to=%2Fme")
        val cancelled = browser.get("/account/auth/google/callback?error=access_denied&state=$state")
        assertEquals("http://127.0.0.1:3000/me?login=1", cancelled.headers().firstValue("location").get())

        val restart = browser.get("/account/auth/google/start?return_to=%2Fme")
        val badCode =
            browser.get(
                "/account/auth/google/callback?code=bad-code&state=${stateOf(restart.headers().firstValue("location").get())}",
            )
        assertTrue(
            badCode
                .headers()
                .firstValue("location")
                .get()
                .endsWith("/me?login=1&error=login_failed"),
        )

        assertEquals(true, mapper.readTree(browser.get("/account/me").body()).get("is_guest").asBoolean())
        assertEquals(404, browser.get("/account/auth/github/start").statusCode())

        // Server events under the guest that tried (TRACKING-PLAN 8-1-3, 8-1-4).
        val recorded = events.forAccount(guest).asReversed()
        assertEquals(
            listOf("state_mismatch", "token_invalid"),
            recorded.filter { it.name == "server_login_failed" }.map { it.properties["reason"] },
        )
        assertEquals(1, recorded.count { it.name == "server_login_cancelled" && it.properties["provider"] == "google" })
    }
}
