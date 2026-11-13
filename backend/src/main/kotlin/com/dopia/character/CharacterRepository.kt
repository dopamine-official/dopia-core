package com.dopia.character

import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.sql.ResultSet
import java.time.Instant
import java.time.OffsetDateTime
import java.util.UUID

data class CharacterRow(
    val id: UUID,
    val creatorId: UUID,
    /** draft, pending, approved or rejected. */
    val status: String,
    val rejectionReason: String?,
    val sourceLocale: String,
    val name: JsonNode,
    val characterName: JsonNode,
    val tagline: JsonNode,
    val firstMessage: JsonNode,
    val personality: JsonNode,
    val speechStyle: JsonNode,
    val worldSetting: JsonNode,
    val statusWindowEnabled: Boolean,
    val statusWindowFormat: JsonNode,
    val statusWindowInitial: JsonNode,
    val statusWindowRules: JsonNode,
    val gender: String?,
    val age: Int?,
    val imageUrl: String?,
    val isAdult: Boolean,
    val deleted: Boolean,
    val updatedAt: Instant,
) {
    val approved get() = status == "approved"
}

data class CharacterImageRow(
    val id: UUID,
    val name: String,
    val description: String,
    val imageUrl: String,
    val position: Int,
)

data class BannerRow(
    val id: UUID,
    val imageUrl: String,
    val linkUrl: String?,
)

data class SectionRow(
    val id: UUID,
    val sourceLocale: String,
    val name: JsonNode,
    val position: Int,
)

data class SectionCharacterRow(
    val sectionId: UUID,
    val characterId: UUID,
    val position: Int,
)

/** The localized text columns a creator writes. */
val TEXT_COLUMNS =
    listOf(
        "name",
        "character_name",
        "tagline",
        "personality",
        "speech_style",
        "world_setting",
        "first_message",
        "status_window_format",
        "status_window_initial",
        "status_window_rules",
    )

/** What one save changes. A null leaves the column as it is. */
data class CharacterChange(
    /** Column to text; an empty text clears the column. */
    val texts: Map<String, String> = emptyMap(),
    /** Present when the request sent the field; the value inside may be null to clear it. */
    val gender: Value<String>? = null,
    val age: Value<Int>? = null,
    val statusWindowEnabled: Boolean? = null,
    val isAdult: Boolean? = null,
    val imageUrl: String? = null,
    val submit: Boolean = false,
) {
    data class Value<T>(
        val value: T?,
    )
}

@Repository
class CharacterRepository(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
) {
    private val columns =
        "id, creator_id, status, rejection_reason, source_locale, name, tagline, first_message, personality, speech_style, " +
            "world_setting, status_window_enabled, status_window_format, status_window_initial, status_window_rules, " +
            "character_name, gender, age, image_url, is_adult, deleted_at, updated_at"

    private fun json(
        rs: ResultSet,
        column: String,
    ): JsonNode = mapper.readTree(rs.getString(column))

    private val character =
        RowMapper { rs: ResultSet, _: Int ->
            CharacterRow(
                id = rs.getObject("id", UUID::class.java),
                creatorId = rs.getObject("creator_id", UUID::class.java),
                status = rs.getString("status"),
                rejectionReason = rs.getString("rejection_reason"),
                sourceLocale = rs.getString("source_locale"),
                name = json(rs, "name"),
                characterName = json(rs, "character_name"),
                tagline = json(rs, "tagline"),
                firstMessage = json(rs, "first_message"),
                personality = json(rs, "personality"),
                speechStyle = json(rs, "speech_style"),
                worldSetting = json(rs, "world_setting"),
                statusWindowEnabled = rs.getBoolean("status_window_enabled"),
                statusWindowFormat = json(rs, "status_window_format"),
                statusWindowInitial = json(rs, "status_window_initial"),
                statusWindowRules = json(rs, "status_window_rules"),
                gender = rs.getString("gender"),
                age = rs.getObject("age") as Int?,
                imageUrl = rs.getString("image_url"),
                isAdult = rs.getBoolean("is_adult"),
                deleted = rs.getObject("deleted_at") != null,
                updatedAt = rs.getObject("updated_at", OffsetDateTime::class.java).toInstant(),
            )
        }

    private val image =
        RowMapper { rs: ResultSet, _: Int ->
            CharacterImageRow(
                rs.getObject("id", UUID::class.java),
                rs.getString("name"),
                rs.getString("description"),
                rs.getString("image_url"),
                rs.getInt("position"),
            )
        }

    fun find(id: UUID): CharacterRow? =
        jdbc
            .sql("SELECT $columns FROM characters WHERE id = :id")
            .param("id", id)
            .query(character)
            .optional()
            .orElse(null)

    /** Locks the row until the transaction ends, so saves, image changes and deletion run one at a time. */
    fun lock(id: UUID): CharacterRow? =
        jdbc
            .sql("SELECT $columns FROM characters WHERE id = :id FOR UPDATE")
            .param("id", id)
            .query(character)
            .optional()
            .orElse(null)

    fun findAll(ids: Collection<UUID>): Map<UUID, CharacterRow> =
        if (ids.isEmpty()) {
            emptyMap()
        } else {
            jdbc
                .sql("SELECT $columns FROM characters WHERE id = ANY(:ids)")
                .param("ids", ids.toTypedArray())
                .query(character)
                .list()
                .associateBy { it.id }
        }

    /** Live, approved characters that may appear on the home page. */
    fun visibleCharacters(): List<CharacterRow> =
        jdbc.sql("SELECT $columns FROM characters WHERE deleted_at IS NULL AND status = 'approved'").query(character).list()

    fun mine(creatorId: UUID): List<CharacterRow> =
        jdbc
            .sql("SELECT $columns FROM characters WHERE creator_id = :creator AND deleted_at IS NULL ORDER BY updated_at DESC")
            .param("creator", creatorId)
            .query(character)
            .list()

    fun approvedBy(creatorId: UUID): List<CharacterRow> =
        jdbc
            .sql(
                "SELECT $columns FROM characters WHERE creator_id = :creator AND status = 'approved' AND deleted_at IS NULL " +
                    "ORDER BY approved_at DESC",
            ).param("creator", creatorId)
            .query(character)
            .list()

    fun insert(
        creatorId: UUID,
        sourceLocale: String,
    ): UUID =
        jdbc
            .sql("INSERT INTO characters (creator_id, source_locale) VALUES (:creator, :locale) RETURNING id")
            .param("creator", creatorId)
            .param("locale", sourceLocale)
            .query(UUID::class.java)
            .single()

    fun update(
        id: UUID,
        sourceLocale: String,
        change: CharacterChange,
    ) {
        val sets = mutableListOf<String>()
        val params = mutableMapOf<String, Any?>("id" to id, "locale" to sourceLocale)
        change.texts.forEach { (column, text) ->
            require(column in TEXT_COLUMNS)
            // Only the language the creator writes in is stored (2-2).
            sets += if (text.isEmpty()) "$column = '{}'::jsonb" else "$column = jsonb_build_object(:locale, :$column)"
            if (text.isNotEmpty()) params[column] = text
        }
        change.gender?.let {
            sets += "gender = :gender"
            params["gender"] = it.value
        }
        change.age?.let {
            sets += "age = :age"
            params["age"] = it.value
        }
        change.statusWindowEnabled?.let {
            sets += "status_window_enabled = :status_window_enabled"
            params["status_window_enabled"] = it
        }
        change.isAdult?.let {
            sets += "is_adult = :is_adult"
            params["is_adult"] = it
        }
        change.imageUrl?.let {
            sets += "image_url = :image_url"
            params["image_url"] = it
        }
        // The status trigger does the same; written here too so the rule is in one statement (3-2-4).
        if (change.submit) sets += "status = 'pending', submitted_at = now(), rejection_reason = NULL"
        if (sets.isEmpty()) return
        var statement = jdbc.sql("UPDATE characters SET ${sets.joinToString()} WHERE id = :id")
        params.forEach { (name, value) -> statement = statement.param(name, value) }
        statement.update()
    }

    /** Marks the row changed: image edits belong to the character's last change time. */
    fun touch(id: UUID) {
        jdbc.sql("UPDATE characters SET updated_at = now() WHERE id = :id").param("id", id).update()
    }

    fun softDelete(id: UUID) {
        jdbc.sql("UPDATE characters SET deleted_at = now() WHERE id = :id").param("id", id).update()
    }

    /** A creator who withdraws takes their characters off every list; rooms that exist keep working (4-1-6). */
    fun softDeleteByCreator(creatorId: UUID) {
        jdbc
            .sql("UPDATE characters SET deleted_at = now() WHERE creator_id = :creator AND deleted_at IS NULL")
            .param("creator", creatorId)
            .update()
    }

    fun images(characterId: UUID): List<CharacterImageRow> =
        jdbc
            .sql("SELECT id, name, description, image_url, position FROM character_images WHERE character_id = :id ORDER BY position")
            .param("id", characterId)
            .query(image)
            .list()

    fun findImage(
        characterId: UUID,
        imageId: UUID,
    ): CharacterImageRow? =
        jdbc
            .sql("SELECT id, name, description, image_url, position FROM character_images WHERE character_id = :character AND id = :id")
            .param("character", characterId)
            .param("id", imageId)
            .query(image)
            .optional()
            .orElse(null)

    fun insertImage(
        characterId: UUID,
        name: String,
        description: String,
        imageUrl: String,
    ): CharacterImageRow =
        jdbc
            .sql(
                "INSERT INTO character_images (character_id, name, description, image_url, position) " +
                    "SELECT :character, :name, :description, :url, coalesce(max(position) + 1, 0) " +
                    "FROM character_images WHERE character_id = :character " +
                    "RETURNING id, name, description, image_url, position",
            ).param("character", characterId)
            .param("name", name)
            .param("description", description)
            .param("url", imageUrl)
            .query(image)
            .single()

    fun updateImage(
        imageId: UUID,
        name: String,
        description: String,
    ) {
        jdbc
            .sql("UPDATE character_images SET name = :name, description = :description WHERE id = :id")
            .param("name", name)
            .param("description", description)
            .param("id", imageId)
            .update()
    }

    fun deleteImage(imageId: UUID) {
        jdbc.sql("DELETE FROM character_images WHERE id = :id").param("id", imageId).update()
    }

    /** The banner the home page shows: the newest public one. A banner is not a character (3-2-10). */
    fun banner(): BannerRow? =
        jdbc
            .sql("SELECT id, image_url, link_url FROM home_banners WHERE is_public ORDER BY created_at DESC, id LIMIT 1")
            .query { rs, _ -> BannerRow(rs.getObject("id", UUID::class.java), rs.getString("image_url"), rs.getString("link_url")) }
            .optional()
            .orElse(null)

    fun publicSections(): List<SectionRow> =
        jdbc
            .sql("SELECT id, source_locale, name, position FROM home_sections WHERE deleted_at IS NULL AND is_public ORDER BY position")
            .query { rs, _ ->
                SectionRow(rs.getObject("id", UUID::class.java), rs.getString("source_locale"), json(rs, "name"), rs.getInt("position"))
            }.list()

    fun sectionCharacters(): List<SectionCharacterRow> =
        jdbc
            .sql("SELECT section_id, character_id, position FROM home_section_characters ORDER BY section_id, position")
            .query { rs, _ ->
                SectionCharacterRow(
                    rs.getObject("section_id", UUID::class.java),
                    rs.getObject("character_id", UUID::class.java),
                    rs.getInt("position"),
                )
            }.list()
}
