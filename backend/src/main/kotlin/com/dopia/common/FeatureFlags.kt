package com.dopia.common

import com.dopia.config.AppProperties
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import tools.jackson.databind.json.JsonMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * PostHog feature flags, evaluated per account on the server. A flag is off unless PostHog says
 * it is on: no key, a slow answer or an error all read as off.
 */
@Component
class FeatureFlags(
    properties: AppProperties,
    private val mapper: JsonMapper,
) {
    private val log = LoggerFactory.getLogger(FeatureFlags::class.java)
    private val settings = properties.posthog
    private val endpoint = URI.create(settings.host.trimEnd('/') + "/flags/?v=2")
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build()

    private data class Answer(
        val until: Instant,
        val on: Set<String>,
    )

    private val cache = ConcurrentHashMap<UUID, Answer>()

    /** Values that win over PostHog: `app.flags` for local runs, and tests set them directly. */
    val overrides = ConcurrentHashMap<String, Boolean>(properties.flags)

    fun enabled(
        flag: String,
        accountId: UUID,
    ): Boolean {
        overrides[flag]?.let { return it }
        if (settings.apiKey.isBlank()) return false
        val cached = cache[accountId]?.takeIf { it.until.isAfter(Instant.now()) }
        return flag in (cached ?: fetch(accountId)).on
    }

    private fun fetch(accountId: UUID): Answer {
        val on =
            try {
                val body = mapper.writeValueAsString(mapOf("api_key" to settings.apiKey, "distinct_id" to accountId.toString()))
                val request =
                    HttpRequest
                        .newBuilder(endpoint)
                        .timeout(Duration.ofSeconds(2))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build()
                val response = http.send(request, HttpResponse.BodyHandlers.ofString())
                if (response.statusCode() >= 300) throw IllegalStateException("status ${response.statusCode()}")
                val flags = mapper.readTree(response.body()).path("flags")
                flags.propertyNames().filter { flags.path(it).path("enabled").asBoolean(false) }.toSet()
            } catch (error: Exception) {
                log.warn("feature flags not read, treating all as off: {}", error.message)
                // A short wait before asking again, so a PostHog outage does not slow every request.
                return Answer(Instant.now().plusSeconds(10), emptySet()).also { cache[accountId] = it }
            }
        if (cache.size > 10_000) cache.clear()
        return Answer(Instant.now().plusSeconds(30), on).also { cache[accountId] = it }
    }
}
