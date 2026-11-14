package com.dopia.character

import com.dopia.account.AccountRepository
import com.dopia.common.I18n
import com.dopia.common.Identity
import com.dopia.common.RequestLocale
import com.dopia.config.AppProperties
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// Home list (4-2-2)
data class HomeBanner(
    val id: UUID,
    val imageUrl: String,
    /** Null for a banner that is only a picture. */
    val linkUrl: String?,
)

data class HomeCharacter(
    val id: UUID,
    val name: String,
    val tagline: String,
    val imageUrl: String,
    val creatorId: UUID,
    val creatorName: String,
)

data class HomeSection(
    val id: UUID,
    val name: String,
    val characters: List<HomeCharacter>,
)

data class HomeResponse(
    val banner: HomeBanner?,
    val sections: List<HomeSection>,
)

/** What the character's status window shows ([format]) and how its values move ([rules], optional). */
data class StatusWindow(
    val format: String,
    val rules: String?,
)

// Character for CHAT (4-2-3)
data class ChatCharacter(
    val id: UUID,
    /** Shown on the card and in lists. May read like a title. */
    val name: String,
    /** What the character is called in the story; the AI gets this one. Falls back to [name]. */
    val characterName: String,
    val imageUrl: String,
    val gender: String,
    val age: Int?,
    val personality: String,
    val speechStyle: String,
    val worldSetting: String,
    /** Null when the creator has the status window turned off. */
    val statusWindow: StatusWindow?,
    val firstMessage: String,
    val isAdult: Boolean,
    val canOpenNewRoom: Boolean,
)

class CharacterNotFound(
    val id: UUID,
) : RuntimeException("character $id not found")

@Service
class CharacterService(
    private val repository: CharacterRepository,
    private val accounts: AccountRepository,
    private val properties: AppProperties,
    private val tx: TransactionTemplate,
) {
    private data class CacheEntry(
        val expiresAt: Instant,
        val value: HomeResponse,
    )

    private val cache = ConcurrentHashMap<String, CacheEntry>()

    /** Adult exposure (CHARACTER 4-1-1 step 2). The PostHog flag defaults to visible until flags are wired. */
    fun adultAllowed(
        identity: Identity,
        locale: RequestLocale,
    ): Boolean = locale.region.adultModeAvailable && identity.isMember && identity.adultMode

    fun home(
        identity: Identity,
        locale: RequestLocale,
    ): HomeResponse {
        val allowed = adultAllowed(identity, locale)
        val key = "${locale.locale}|${locale.region.code}|$allowed"
        cache[key]?.takeIf { it.expiresAt.isAfter(Instant.now()) }?.let { return it.value }
        // One transaction so every table is read from the same snapshot.
        val value = tx.execute { buildHome(locale.locale, allowed) }!!
        cache[key] = CacheEntry(Instant.now().plus(properties.home.cacheTtl), value)
        return value
    }

    fun clearCache() = cache.clear()

    private fun buildHome(
        locale: String,
        adultAllowed: Boolean,
    ): HomeResponse {
        val visible = repository.visibleCharacters().filter { adultAllowed || !it.isAdult }
        // The creator's current nickname (4-1-1 step 7). A character whose creator is gone is left out.
        val creators = accounts.profiles(visible.map { it.creatorId }.toSet())
        val characters = visible.filter { it.creatorId in creators }.associateBy { it.id }
        val membership = repository.sectionCharacters().groupBy { it.sectionId }
        val sections =
            repository.publicSections().mapNotNull { section ->
                val members = membership[section.id].orEmpty().sortedBy { it.position }.mapNotNull { characters[it.characterId] }
                if (members.isEmpty()) return@mapNotNull null
                HomeSection(
                    id = section.id,
                    name = I18n.resolveText(section.name, section.sourceLocale, locale),
                    characters =
                        members.map {
                            HomeCharacter(
                                id = it.id,
                                name = I18n.resolveText(it.name, it.sourceLocale, locale),
                                tagline = I18n.resolveText(it.tagline, it.sourceLocale, locale),
                                imageUrl = it.imageUrl.orEmpty(),
                                creatorId = it.creatorId,
                                creatorName = creators.getValue(it.creatorId).first,
                            )
                        },
                )
            }
        // The same banner for everyone: it is not a character, so nothing filters it.
        val banner = repository.banner()?.let { HomeBanner(it.id, it.imageUrl, it.linkUrl) }
        return HomeResponse(banner, sections)
    }

    /**
     * Uncached per-call lookup for CHAT (4-1-4). [requesterId] is the account opening a room: a
     * creator may open one with their own character before it is approved. A draft does not exist
     * for CHAT.
     */
    fun forChat(
        characterId: UUID,
        locale: String,
        adultAllowed: Boolean,
        requesterId: UUID? = null,
    ): ChatCharacter {
        val row = repository.find(characterId)?.takeIf { it.status != "draft" } ?: throw CharacterNotFound(characterId)
        // The creator gets what they last submitted; everyone else what is public (4-1-4 step 2).
        val seen = if (row.approved && row.creatorId == requesterId) row.with(repository.revision(row.id)) else row
        return toChat(seen, locale, adultAllowed, requesterId)
    }

    fun forChat(
        ids: Collection<UUID>,
        locale: String,
        requesterId: UUID? = null,
    ): Map<UUID, ChatCharacter> {
        val rows = repository.findAll(ids).filterValues { it.status != "draft" }
        val revisions = repository.revisions(rows.values.filter { it.approved && it.creatorId == requesterId }.map { it.id })
        return rows.mapValues { (id, row) -> toChat(row.with(revisions[id]), locale, adultAllowed = false, requesterId = requesterId) }
    }

    private fun toChat(
        row: CharacterRow,
        locale: String,
        adultAllowed: Boolean,
        requesterId: UUID?,
    ): ChatCharacter {
        fun text(texts: tools.jackson.databind.JsonNode) = I18n.resolveText(texts, row.sourceLocale, locale)
        val name = text(row.name)
        val statusWindowFormat = if (row.statusWindowEnabled) text(row.statusWindowFormat).trim().ifEmpty { null } else null
        // The creator writes only the values; the tags are ours (4-1-4 step 3-1).
        val initial = if (statusWindowFormat != null) text(row.statusWindowInitial).trim() else ""
        val firstMessage = text(row.firstMessage)
        return ChatCharacter(
            id = row.id,
            name = name,
            characterName = text(row.characterName).trim().ifEmpty { name },
            imageUrl = row.imageUrl.orEmpty(),
            gender = row.gender.orEmpty(),
            age = row.age,
            personality = text(row.personality),
            speechStyle = text(row.speechStyle),
            worldSetting = text(row.worldSetting),
            statusWindow = statusWindowFormat?.let { StatusWindow(it, text(row.statusWindowRules).trim().ifEmpty { null }) },
            firstMessage = if (initial.isEmpty()) firstMessage else "$firstMessage\n<status>\n$initial\n</status>",
            isAdult = row.isAdult,
            canOpenNewRoom = !row.deleted && (row.approved || row.creatorId == requesterId) && (!row.isAdult || adultAllowed),
        )
    }
}
