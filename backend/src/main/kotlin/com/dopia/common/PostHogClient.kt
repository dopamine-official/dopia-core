package com.dopia.common

import com.dopia.config.AppProperties
import jakarta.annotation.PreDestroy
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
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Sends server events to PostHog's capture endpoint (TRACKING-PLAN 8). Each event goes out on
 * its own request in the background: a slow or failing PostHog never delays or fails the
 * request that produced it, and an event that cannot be sent is logged and dropped.
 */
@Component
class PostHogClient(
    properties: AppProperties,
    private val mapper: JsonMapper,
) {
    private val log = LoggerFactory.getLogger(PostHogClient::class.java)
    private val settings = properties.posthog
    private val enabled = settings.apiKey.isNotBlank()
    private val endpoint = URI.create(settings.host.trimEnd('/') + "/i/v0/e/")
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val inFlight = ConcurrentHashMap.newKeySet<CompletableFuture<*>>()

    init {
        // PostHog hides `dev` from every chart, so a production server that fell back to it
        // would vanish; with a key the environment must be explicit (same rule as chat-ai).
        check(!enabled || settings.environment in setOf("dev", "prod")) {
            "APP_ENV must be dev or prod when POSTHOG_API_KEY is set"
        }
    }

    fun capture(
        distinctId: UUID,
        event: String,
        properties: Map<String, Any?>,
        at: Instant,
    ) {
        if (!enabled) return
        val body =
            mapper.writeValueAsString(
                mapOf(
                    "api_key" to settings.apiKey,
                    "event" to event,
                    "distinct_id" to distinctId.toString(),
                    "timestamp" to at.toString(),
                    "properties" to
                        properties + mapOf("environment" to settings.environment, "app_release" to settings.release),
                ),
            )
        val request =
            HttpRequest
                .newBuilder(endpoint)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build()
        val sent =
            http
                .sendAsync(request, HttpResponse.BodyHandlers.discarding())
                .handle { response, error ->
                    if (error != null) {
                        log.warn("posthog {} not sent: {}", event, error.message)
                    } else if (response.statusCode() >= 300) {
                        log.warn("posthog {} not sent: status {}", event, response.statusCode())
                    }
                }
        inFlight.add(sent)
        sent.whenComplete { _, _ -> inFlight.remove(sent) }
    }

    /** On shutdown, give events still on their way a moment to arrive. */
    @PreDestroy
    fun flush() {
        runCatching {
            CompletableFuture.allOf(*inFlight.toTypedArray()).get(5, TimeUnit.SECONDS)
        }
    }
}
