package com.dopia.character

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
data class HomeBanner(val characterId: UUID, val name: String, val imageUrl: String)
data class HomeCharacter(val id: UUID, val name: String, val tagline: String, val imageUrl: String, val creatorName: String)
data class HomeSection(val id: UUID, val name: String, val characters: List<HomeCharacter>)
data class HomeResponse(val banner: HomeBanner?, val sections: List<HomeSection>)

// Character for CHAT (4-2-3)
data class ChatCharacter(
    val id: UUID,
    val name: String,
    val imageUrl: String,
    val gender: String,
    val personality: String,
    val speechStyle: String,
    val worldSetting: String,
    val firstMessage: String,
    val isAdult: Boolean,
    val canOpenNewRoom: Boolean,
)

class CharacterNotFound(val id: UUID) : RuntimeException("character $id not found")

@Service
class CharacterService(
    private val repository: CharacterRepository,
    private val properties: AppProperties,
    private val tx: TransactionTemplate,
) {
    private data class CacheEntry(val expiresAt: Instant, val value: HomeResponse)
    private val cache = ConcurrentHashMap<String, CacheEntry>()

    /** Adult exposure (CHARACTER 4-1-1 step 2). The PostHog flag defaults to visible until flags are wired. */
    fun adultAllowed(identity: Identity, locale: RequestLocale): Boolean =
        locale.region.adultModeAvailable && identity.isMember && identity.adultMode

    fun home(identity: Identity, locale: RequestLocale): HomeResponse {
        val allowed = adultAllowed(identity, locale)
        val key = "${locale.locale}|${locale.region.code}|$allowed"
        cache[key]?.takeIf { it.expiresAt.isAfter(Instant.now()) }?.let { return it.value }
        // One transaction so every table is read from the same snapshot.
        val value = tx.execute { buildHome(locale.locale, allowed) }!!
        cache[key] = CacheEntry(Instant.now().plus(properties.home.cacheTtl), value)
        return value
    }

    fun clearCache() = cache.clear()

    private fun buildHome(locale: String, adultAllowed: Boolean): HomeResponse {
        val characters = repository.visibleCharacters().filter { adultAllowed || !it.isAdult }.associateBy { it.id }
        val membership = repository.sectionCharacters().groupBy { it.sectionId }
        val sections = repository.publicSections().mapNotNull { section ->
            val members = membership[section.id].orEmpty().sortedBy { it.position }.mapNotNull { characters[it.characterId] }
            if (members.isEmpty()) return@mapNotNull null
            HomeSection(
                id = section.id,
                name = I18n.resolveText(section.name, section.sourceLocale, locale),
                characters = members.map {
                    HomeCharacter(
                        id = it.id,
                        name = I18n.resolveText(it.name, it.sourceLocale, locale),
                        tagline = I18n.resolveText(it.tagline, it.sourceLocale, locale),
                        imageUrl = it.imageUrl,
                        creatorName = it.creatorName,
                    )
                },
            )
        }
        val banner = characters.values.firstOrNull { it.isBanner && it.bannerImageUrl != null }?.let {
            HomeBanner(it.id, I18n.resolveText(it.name, it.sourceLocale, locale), it.bannerImageUrl!!)
        }
        return HomeResponse(banner, sections)
    }

    /** Uncached per-call lookup for CHAT (4-1-2). */
    fun forChat(characterId: UUID, locale: String, adultAllowed: Boolean): ChatCharacter {
        val row = repository.find(characterId) ?: throw CharacterNotFound(characterId)
        return toChat(row, locale, adultAllowed)
    }

    fun forChat(ids: Collection<UUID>, locale: String): Map<UUID, ChatCharacter> =
        repository.findAll(ids).mapValues { (_, row) -> toChat(row, locale, adultAllowed = false) }

    private fun toChat(row: CharacterRow, locale: String, adultAllowed: Boolean) = ChatCharacter(
        id = row.id,
        name = I18n.resolveText(row.name, row.sourceLocale, locale),
        imageUrl = row.imageUrl,
        gender = row.gender,
        personality = I18n.resolveText(row.personality, row.sourceLocale, locale),
        speechStyle = I18n.resolveText(row.speechStyle, row.sourceLocale, locale),
        worldSetting = I18n.resolveText(row.worldSetting, row.sourceLocale, locale),
        firstMessage = I18n.resolveText(row.firstMessage, row.sourceLocale, locale),
        isAdult = row.isAdult,
        canOpenNewRoom = !row.deleted && row.isPublic && (!row.isAdult || adultAllowed),
    )
}
