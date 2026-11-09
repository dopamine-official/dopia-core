package com.dopia.config

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

/** Operator settings. Values come from environment variables; see application.yml. */
@ConfigurationProperties(prefix = "app")
data class AppProperties(
    val instanceId: String = "local",
    val regionProfile: String = "development",
    val cookie: Cookie = Cookie(),
    val session: Session = Session(),
    val photo: Photo = Photo(),
    val storage: Storage = Storage(),
    val ai: Ai = Ai(),
    val turns: Turns = Turns(),
    val home: Home = Home(),
    val oauth: OAuth = OAuth(),
    val posthog: PostHog = PostHog(),
) {
    data class Cookie(
        val secure: Boolean = true,
        val domain: String = "",
    )

    data class Session(
        val ttl: Duration = Duration.ofDays(30),
    )

    data class Photo(
        val maxBytes: Long = 2L * 1024 * 1024,
    )

    data class Storage(
        /** local or r2 */
        val mode: String = "local",
        val localDir: String = "./data/photos",
        val publicBaseUrl: String = "/files",
        /** Cloudflare R2 (S3 compatible) */
        val r2AccountId: String = "",
        val r2AccessKeyId: String = "",
        val r2SecretAccessKey: String = "",
        val r2Bucket: String = "",
        /** Public origin of the bucket, e.g. https://pub-xxxx.r2.dev or a custom domain. */
        val r2PublicBaseUrl: String = "",
    )

    data class Ai(
        val mode: String = "stub",
        val baseUrl: String = "http://127.0.0.1:8100",
        val timeout: Duration = Duration.ofSeconds(90),
    )

    data class Turns(
        val maxConcurrent: Int = 64,
        val heartbeat: Duration = Duration.ofSeconds(5),
        val lostAfter: Duration = Duration.ofSeconds(45),
    )

    /** Server events (TRACKING-PLAN 8). Off when apiKey is blank. */
    data class PostHog(
        val apiKey: String = "",
        val host: String = "https://us.i.posthog.com",
        /** dev or prod; required when apiKey is set, because PostHog hides `dev` from charts. */
        val environment: String = "",
        val release: String = "local",
    )

    data class Home(
        val cacheTtl: Duration = Duration.ofSeconds(60),
    )

    data class OAuth(
        /** Origin the browser uses to reach this API (callbacks are registered under it). */
        val redirectBaseUrl: String = "http://127.0.0.1:3000",
        /** Origin of the web app for post-login redirects. */
        val webBaseUrl: String = "http://127.0.0.1:3000",
        /** HMAC key for the login_state cookie. */
        val stateKey: String = "dev-only-login-state-key",
        val google: Google = Google(),
        val apple: Apple = Apple(),
    )

    data class Google(
        val clientId: String = "",
        val clientSecret: String = "",
        val authorizeUrl: String = "https://accounts.google.com/o/oauth2/v2/auth",
        val tokenUrl: String = "https://oauth2.googleapis.com/token",
        val jwksUrl: String = "https://www.googleapis.com/oauth2/v3/certs",
    )

    data class Apple(
        val clientId: String = "",
        val teamId: String = "",
        val keyId: String = "",
        val privateKey: String = "",
        val authorizeUrl: String = "https://appleid.apple.com/auth/authorize",
        val tokenUrl: String = "https://appleid.apple.com/auth/token",
        val jwksUrl: String = "https://appleid.apple.com/auth/keys",
    )
}
