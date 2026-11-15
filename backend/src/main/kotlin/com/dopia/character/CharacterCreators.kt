package com.dopia.character

import com.dopia.config.AppProperties
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.util.UUID

/**
 * Who may make characters: the member accounts listed in `app.character.creators`
 * (CHARACTER_CREATORS, account IDs separated by commas), or every member when it is `*`.
 * Nobody when it is empty. A value that is not an account ID is skipped with a warning.
 */
@Component
class CharacterCreators(
    properties: AppProperties,
) {
    private val listed =
        properties.character.creators
            .split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
    private val ids =
        listed
            .filter { it != "*" }
            .mapNotNull { value ->
                runCatching { UUID.fromString(value) }
                    .onFailure {
                        LoggerFactory
                            .getLogger(
                                CharacterCreators::class.java,
                            ).warn("CHARACTER_CREATORS: not an account ID, skipped: {}", value)
                    }.getOrNull()
            }.toSet()

    /** Every member may make characters. Tests set it directly. */
    @Volatile
    var everyone = "*" in listed

    fun allows(accountId: UUID): Boolean = everyone || accountId in ids
}
