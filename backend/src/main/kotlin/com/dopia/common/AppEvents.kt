package com.dopia.common

import org.springframework.stereotype.Component
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

data class AppEvent(
    val name: String,
    val at: Instant,
    val accountId: UUID,
    val properties: Map<String, Any?>,
    /** Person properties sent as `$set`. */
    val person: Map<String, Any> = emptyMap(),
)

/**
 * Product events. [record] sends a server event to PostHog (TRACKING-PLAN 8) under the
 * account's ID; callers record only after the change is committed. The last events are also
 * kept in memory so the dev preview page can show them.
 */
@Component
class AppEvents(
    private val posthog: PostHogClient,
) {
    private val events = CopyOnWriteArrayList<AppEvent>()

    /** [person] goes to PostHog as `$set`, the person properties (TRACKING-PLAN 8-4). */
    fun record(
        accountId: UUID,
        name: String,
        properties: Map<String, Any?> = emptyMap(),
        person: Map<String, Any> = emptyMap(),
    ) {
        // An unknown value (e.g. token counts the AI did not report) is left out, not sent as
        // null; the dev preview's event list accepts only strings, numbers, booleans and lists.
        val known = properties.filterValues { it != null }
        val event = AppEvent(name, Instant.now(), accountId, known, person)
        keep(event)
        posthog.capture(accountId, name, if (person.isEmpty()) known else known + ("\$set" to person), event.at)
    }

    /** Dev preview only: shown on the preview page, never sent. */
    fun note(
        accountId: UUID,
        name: String,
        properties: Map<String, Any?> = emptyMap(),
    ) = keep(AppEvent(name, Instant.now(), accountId, properties))

    private fun keep(event: AppEvent) {
        events.add(event)
        while (events.size > 200) events.removeAt(0)
    }

    fun forAccount(accountId: UUID): List<AppEvent> = events.filter { it.accountId == accountId }.asReversed()

    /** Guest events belong to the member after login, like PostHog aliasing. */
    fun alias(
        from: UUID,
        to: UUID,
    ) {
        val moved = events.map { if (it.accountId == from) it.copy(accountId = to) else it }
        events.clear()
        events.addAll(moved)
    }

    fun clear() = events.clear()
}
