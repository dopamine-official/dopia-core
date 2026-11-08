package com.dopia.common

import org.springframework.stereotype.Component
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

data class AppEvent(
    val name: String,
    val at: Instant,
    val accountId: UUID,
    val properties: Map<String, Any>,
)

/**
 * Product events (5-4 OBSERVABILITY). PostHog is not wired yet; the last events are kept in
 * memory so the dev preview page can show them.
 */
@Component
class AppEvents {
    private val events = CopyOnWriteArrayList<AppEvent>()

    fun record(
        accountId: UUID,
        name: String,
        properties: Map<String, Any> = emptyMap(),
    ) {
        events.add(AppEvent(name, Instant.now(), accountId, properties))
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
