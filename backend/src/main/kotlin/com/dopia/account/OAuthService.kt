package com.dopia.account

import com.dopia.config.AppProperties
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.math.BigInteger
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Signed contents of the login_state cookie (ACCOUNT 4-1-3 step 3). */
data class LoginState(
    val state: String,
    val returnTo: String,
    val guestAccountId: UUID?,
    val expiresAt: Long,
)

class LoginFailed(
    message: String,
) : RuntimeException(message)

/**
 * Google sign-in, the only provider (ACCOUNT 4-1-3, 4-1-4, 5-1-1). Token exchange and ID token
 * verification use the JDK only; provider keys are cached in memory.
 */
@Service
class OAuthService(
    private val properties: AppProperties,
    private val mapper: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(OAuthService::class.java)
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    private val base64 = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    private val google get() = properties.oauth.google

    fun isProvider(name: String) = name == PROVIDER

    fun isConfigured(): Boolean = google.clientId.isNotBlank() && google.clientSecret.isNotBlank()

    fun callbackUrl() = "${properties.oauth.redirectBaseUrl.trimEnd('/')}/api/v1/account/auth/$PROVIDER/callback"

    /** return_to must be a local path; anything else becomes "/". (5-1-2) */
    fun safeReturnTo(value: String?): String =
        if (value != null && value.startsWith("/") && !value.startsWith("//") && value.none { it < ' ' || it == '\\' }) value else "/"

    fun webUrl(path: String) = properties.oauth.webBaseUrl.trimEnd('/') + path

    /** Sends the browser back to return_to with the login modal reopened (ACCOUNT 4-2-3). */
    fun loginModalUrl(
        returnTo: String,
        failed: Boolean,
    ): String {
        val query = "login=1" + if (failed) "&error=login_failed" else ""
        return webUrl(returnTo + (if ('?' in returnTo) "&" else "?") + query)
    }

    // Login state cookie

    fun newState(
        returnTo: String,
        guestAccountId: UUID?,
    ): LoginState =
        LoginState(
            base64.encodeToString(UUID.randomUUID().toString().toByteArray()),
            returnTo,
            guestAccountId,
            Instant.now().plus(Duration.ofMinutes(10)).epochSecond,
        )

    fun sign(state: LoginState): String {
        val payload = base64.encodeToString(mapper.writeValueAsBytes(state))
        return "$payload.${hmac(payload)}"
    }

    fun verify(cookie: String?): LoginState {
        val (payload, signature) = cookie?.split('.')?.takeIf { it.size == 2 } ?: throw LoginFailed("login_state missing")
        if (!constantEquals(hmac(payload), signature)) throw LoginFailed("login_state signature mismatch")
        val state = mapper.readValue(decoder.decode(payload), LoginState::class.java)
        if (state.expiresAt < Instant.now().epochSecond) throw LoginFailed("login_state expired")
        return state
    }

    private fun hmac(value: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(properties.oauth.stateKey.toByteArray(), "HmacSHA256"))
        return base64.encodeToString(mac.doFinal(value.toByteArray()))
    }

    private fun constantEquals(
        a: String,
        b: String,
    ): Boolean = java.security.MessageDigest.isEqual(a.toByteArray(), b.toByteArray())

    // Authorization redirect

    fun authorizeUrl(state: String): String {
        val params =
            linkedMapOf(
                "client_id" to google.clientId,
                "redirect_uri" to callbackUrl(),
                "response_type" to "code",
                "scope" to SCOPE,
                "state" to state,
            )
        return google.authorizeUrl + "?" + params.entries.joinToString("&") { "${it.key}=${encode(it.value)}" }
    }

    // Callback: code exchange and ID token verification (4-1-4 step 3)

    fun exchange(code: String): AccountService.ProviderProfile {
        val form =
            linkedMapOf(
                "grant_type" to "authorization_code",
                "code" to code,
                "redirect_uri" to callbackUrl(),
                "client_id" to google.clientId,
                "client_secret" to google.clientSecret,
            )
        val response =
            http.send(
                HttpRequest
                    .newBuilder(URI(google.tokenUrl))
                    .timeout(Duration.ofSeconds(15))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(form.entries.joinToString("&") { "${it.key}=${encode(it.value)}" }))
                    .build(),
                HttpResponse.BodyHandlers.ofString(),
            )
        if (response.statusCode() != 200) throw LoginFailed("token exchange returned ${response.statusCode()}")
        val idToken = mapper.readTree(response.body()).path("id_token").asString()
        if (idToken.isEmpty()) throw LoginFailed("token response without id_token")
        val claims = verifyIdToken(idToken)
        val subject = claims.path("sub").asString().ifEmpty { throw LoginFailed("id token without sub") }
        val email = claims.path("email").asString().ifEmpty { null }
        val name = claims.path("name").asString().ifEmpty { null }
        return AccountService.ProviderProfile(PROVIDER, subject, name, email)
    }

    private fun verifyIdToken(token: String): JsonNode {
        val parts = token.split('.')
        if (parts.size != 3) throw LoginFailed("malformed id token")
        val header = mapper.readTree(decoder.decode(parts[0]))
        val claims = mapper.readTree(decoder.decode(parts[1]))
        if (header.path("alg").asString() != "RS256") throw LoginFailed("unsupported id token alg")
        val key = publicKey(header.path("kid").asString()) ?: throw LoginFailed("unknown signing key")
        val verifier = Signature.getInstance("SHA256withRSA")
        verifier.initVerify(key)
        verifier.update("${parts[0]}.${parts[1]}".toByteArray())
        if (!verifier.verify(decoder.decode(parts[2]))) throw LoginFailed("id token signature invalid")
        if (claims.path("iss").asString() !in ISSUERS) throw LoginFailed("id token issuer mismatch")
        val audience = claims.path("aud")
        val audOk =
            if (audience.isArray) {
                audience.values().any { it.asString() == google.clientId }
            } else {
                audience.asString() == google.clientId
            }
        if (!audOk) throw LoginFailed("id token audience mismatch")
        if (claims.path("exp").asLong() < Instant.now().epochSecond) throw LoginFailed("id token expired")
        return claims
    }

    // Provider public keys, cached and refreshed on unknown kid (5-3-3)

    private data class Jwks(
        val keys: Map<String, java.security.PublicKey>,
        val fetchedAt: Instant,
    )

    @Volatile private var jwks: Jwks? = null

    private fun publicKey(kid: String): java.security.PublicKey? {
        val cached = jwks
        cached?.keys?.get(kid)?.let { return it }
        if (cached != null && cached.fetchedAt.isAfter(Instant.now().minus(Duration.ofMinutes(1)))) return null
        val fetched =
            runCatching { fetchJwks(google.jwksUrl) }
                .onFailure { log.warn("could not fetch google keys", it) }
                .getOrNull() ?: return cached?.keys?.get(kid)
        jwks = Jwks(fetched, Instant.now())
        return fetched[kid]
    }

    private fun fetchJwks(url: String): Map<String, java.security.PublicKey> {
        val body =
            http
                .send(
                    HttpRequest
                        .newBuilder(URI(url))
                        .timeout(Duration.ofSeconds(10))
                        .GET()
                        .build(),
                    HttpResponse.BodyHandlers.ofString(),
                ).body()
        val factory = KeyFactory.getInstance("RSA")
        return mapper
            .readTree(body)
            .path("keys")
            .values()
            .filter { it.path("kty").asString() == "RSA" }
            .associate { key ->
                val modulus = BigInteger(1, decoder.decode(key.path("n").asString()))
                val exponent = BigInteger(1, decoder.decode(key.path("e").asString()))
                key.path("kid").asString() to factory.generatePublic(RSAPublicKeySpec(modulus, exponent))
            }
    }

    private fun encode(value: String) = URLEncoder.encode(value, Charsets.UTF_8)

    companion object {
        const val PROVIDER = "google"
        private const val SCOPE = "openid email profile"
        private val ISSUERS = setOf("https://accounts.google.com", "accounts.google.com")
    }
}
