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
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.RSAPublicKeySpec
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Signed contents of the login_state cookie (ACCOUNT 4-1-3 step 3). */
data class LoginState(
    val state: String,
    val returnTo: String,
    val guestAccountId: UUID?,
    val provider: String,
    val expiresAt: Long,
)

class LoginFailed(message: String) : RuntimeException(message)

/**
 * Google and Apple sign-in (ACCOUNT 4-1-3, 4-1-4, 5-1-1). Token exchange and ID token
 * verification use the JDK only; provider keys are cached in memory.
 */
@Service
class OAuthService(private val properties: AppProperties, private val mapper: ObjectMapper) {
    private val log = LoggerFactory.getLogger(OAuthService::class.java)
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    private val base64 = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    data class Provider(
        val name: String,
        val authorizeUrl: String,
        val tokenUrl: String,
        val jwksUrl: String,
        val issuers: Set<String>,
        val scope: String,
    )

    private val providers = mapOf(
        "google" to Provider(
            "google", properties.oauth.google.authorizeUrl, properties.oauth.google.tokenUrl, properties.oauth.google.jwksUrl,
            setOf("https://accounts.google.com", "accounts.google.com"), "openid email profile",
        ),
        "apple" to Provider(
            "apple", properties.oauth.apple.authorizeUrl, properties.oauth.apple.tokenUrl, properties.oauth.apple.jwksUrl,
            setOf("https://appleid.apple.com"), "name email",
        ),
    )

    fun isProvider(name: String) = name in providers

    fun isConfigured(provider: String): Boolean = when (provider) {
        "google" -> properties.oauth.google.clientId.isNotBlank() && properties.oauth.google.clientSecret.isNotBlank()
        "apple" -> properties.oauth.apple.clientId.isNotBlank() && properties.oauth.apple.privateKey.isNotBlank()
        else -> false
    }

    fun callbackUrl(provider: String) = "${properties.oauth.redirectBaseUrl.trimEnd('/')}/api/v1/account/auth/$provider/callback"

    /** return_to must be a local path; anything else becomes "/". (5-1-2) */
    fun safeReturnTo(value: String?): String =
        if (value != null && value.startsWith("/") && !value.startsWith("//") && value.none { it < ' ' || it == '\\' }) value else "/"

    fun webUrl(path: String) = properties.oauth.webBaseUrl.trimEnd('/') + path

    /** Sends the browser back to return_to with the login modal reopened (ACCOUNT 4-2-3). */
    fun loginModalUrl(returnTo: String, failed: Boolean): String {
        val query = "login=1" + if (failed) "&error=login_failed" else ""
        return webUrl(returnTo + (if ('?' in returnTo) "&" else "?") + query)
    }

    // Login state cookie

    fun newState(provider: String, returnTo: String, guestAccountId: UUID?): LoginState =
        LoginState(base64.encodeToString(UUID.randomUUID().toString().toByteArray()), returnTo, guestAccountId, provider,
            Instant.now().plus(Duration.ofMinutes(10)).epochSecond)

    fun sign(state: LoginState): String {
        val payload = base64.encodeToString(mapper.writeValueAsBytes(state))
        return "$payload.${hmac(payload)}"
    }

    fun verify(cookie: String?, provider: String): LoginState {
        val (payload, signature) = cookie?.split('.')?.takeIf { it.size == 2 } ?: throw LoginFailed("login_state missing")
        if (!constantEquals(hmac(payload), signature)) throw LoginFailed("login_state signature mismatch")
        val state = mapper.readValue(decoder.decode(payload), LoginState::class.java)
        if (state.expiresAt < Instant.now().epochSecond) throw LoginFailed("login_state expired")
        if (state.provider != provider) throw LoginFailed("login_state provider mismatch")
        return state
    }

    private fun hmac(value: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(properties.oauth.stateKey.toByteArray(), "HmacSHA256"))
        return base64.encodeToString(mac.doFinal(value.toByteArray()))
    }

    private fun constantEquals(a: String, b: String): Boolean =
        java.security.MessageDigest.isEqual(a.toByteArray(), b.toByteArray())

    // Authorization redirect

    fun authorizeUrl(provider: String, state: String): String {
        val config = providers.getValue(provider)
        val params = linkedMapOf(
            "client_id" to clientId(provider),
            "redirect_uri" to callbackUrl(provider),
            "response_type" to "code",
            "scope" to config.scope,
            "state" to state,
        )
        if (provider == "apple") params["response_mode"] = "form_post"
        return config.authorizeUrl + "?" + params.entries.joinToString("&") { "${it.key}=${encode(it.value)}" }
    }

    // Callback: code exchange and ID token verification (4-1-4 step 3)

    fun exchange(provider: String, code: String, appleUser: String?): AccountService.ProviderProfile {
        val config = providers.getValue(provider)
        val form = linkedMapOf(
            "grant_type" to "authorization_code",
            "code" to code,
            "redirect_uri" to callbackUrl(provider),
            "client_id" to clientId(provider),
            "client_secret" to clientSecret(provider),
        )
        val response = http.send(
            HttpRequest.newBuilder(URI(config.tokenUrl))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form.entries.joinToString("&") { "${it.key}=${encode(it.value)}" }))
                .build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        if (response.statusCode() != 200) throw LoginFailed("token exchange returned ${response.statusCode()}")
        val idToken = mapper.readTree(response.body()).path("id_token").asString()
        if (idToken.isEmpty()) throw LoginFailed("token response without id_token")
        val claims = verifyIdToken(config, idToken)
        val subject = claims.path("sub").asString().ifEmpty { throw LoginFailed("id token without sub") }
        val email = claims.path("email").asString().ifEmpty { null }
        val name = when (provider) {
            "google" -> claims.path("name").asString().ifEmpty { null }
            else -> appleName(appleUser)
        }
        return AccountService.ProviderProfile(provider, subject, name, email)
    }

    private fun appleName(user: String?): String? {
        val node = user?.let { runCatching { mapper.readTree(it) }.getOrNull() } ?: return null
        val first = node.path("name").path("firstName").asString()
        val last = node.path("name").path("lastName").asString()
        return listOf(first, last).filter { it.isNotBlank() }.joinToString(" ").ifBlank { null }
    }

    private fun verifyIdToken(config: Provider, token: String): JsonNode {
        val parts = token.split('.')
        if (parts.size != 3) throw LoginFailed("malformed id token")
        val header = mapper.readTree(decoder.decode(parts[0]))
        val claims = mapper.readTree(decoder.decode(parts[1]))
        if (header.path("alg").asString() != "RS256") throw LoginFailed("unsupported id token alg")
        val key = publicKey(config, header.path("kid").asString()) ?: throw LoginFailed("unknown signing key")
        val verifier = Signature.getInstance("SHA256withRSA")
        verifier.initVerify(key)
        verifier.update("${parts[0]}.${parts[1]}".toByteArray())
        if (!verifier.verify(decoder.decode(parts[2]))) throw LoginFailed("id token signature invalid")
        if (claims.path("iss").asString() !in config.issuers) throw LoginFailed("id token issuer mismatch")
        val audience = claims.path("aud")
        val audOk = if (audience.isArray) audience.values().any { it.asString() == clientId(config.name) } else audience.asString() == clientId(config.name)
        if (!audOk) throw LoginFailed("id token audience mismatch")
        if (claims.path("exp").asLong() < Instant.now().epochSecond) throw LoginFailed("id token expired")
        return claims
    }

    // Provider public keys, cached and refreshed on unknown kid (5-3-3)

    private data class Jwks(val keys: Map<String, java.security.PublicKey>, val fetchedAt: Instant)
    private val jwks = ConcurrentHashMap<String, Jwks>()

    private fun publicKey(config: Provider, kid: String): java.security.PublicKey? {
        val cached = jwks[config.name]
        cached?.keys?.get(kid)?.let { return it }
        if (cached != null && cached.fetchedAt.isAfter(Instant.now().minus(Duration.ofMinutes(1)))) return null
        val fetched = runCatching { fetchJwks(config.jwksUrl) }
            .onFailure { log.warn("could not fetch {} keys", config.name, it) }
            .getOrNull() ?: return cached?.keys?.get(kid)
        jwks[config.name] = Jwks(fetched, Instant.now())
        return fetched[kid]
    }

    private fun fetchJwks(url: String): Map<String, java.security.PublicKey> {
        val body = http.send(HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(10)).GET().build(), HttpResponse.BodyHandlers.ofString()).body()
        val factory = KeyFactory.getInstance("RSA")
        return mapper.readTree(body).path("keys").values()
            .filter { it.path("kty").asString() == "RSA" }
            .associate { key ->
                val modulus = BigInteger(1, decoder.decode(key.path("n").asString()))
                val exponent = BigInteger(1, decoder.decode(key.path("e").asString()))
                key.path("kid").asString() to factory.generatePublic(RSAPublicKeySpec(modulus, exponent))
            }
    }

    // Client credentials

    private fun clientId(provider: String) =
        if (provider == "google") properties.oauth.google.clientId else properties.oauth.apple.clientId

    private fun clientSecret(provider: String): String =
        if (provider == "google") properties.oauth.google.clientSecret else appleClientSecret()

    /** Apple's client secret is a short-lived ES256 JWT signed with the .p8 key. */
    private fun appleClientSecret(): String {
        val apple = properties.oauth.apple
        val now = Instant.now().epochSecond
        val header = base64.encodeToString("""{"alg":"ES256","kid":"${apple.keyId}"}""".toByteArray())
        val payload = base64.encodeToString(
            """{"iss":"${apple.teamId}","iat":$now,"exp":${now + 300},"aud":"https://appleid.apple.com","sub":"${apple.clientId}"}""".toByteArray(),
        )
        val signer = Signature.getInstance("SHA256withECDSAinP1363Format")
        signer.initSign(applePrivateKey())
        signer.update("$header.$payload".toByteArray())
        return "$header.$payload.${base64.encodeToString(signer.sign())}"
    }

    private fun applePrivateKey(): PrivateKey {
        val pem = properties.oauth.apple.privateKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "")
            .replace("\\n", "").replace("\n", "").trim()
        return KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)))
    }

    private fun encode(value: String) = URLEncoder.encode(value, Charsets.UTF_8)
}
