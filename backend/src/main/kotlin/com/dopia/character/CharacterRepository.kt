package com.dopia.character

import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.sql.ResultSet
import java.util.UUID

data class CharacterRow(
    val id: UUID,
    val sourceLocale: String,
    val name: JsonNode,
    val tagline: JsonNode,
    val firstMessage: JsonNode,
    val personality: JsonNode,
    val speechStyle: JsonNode,
    val worldSetting: JsonNode,
    val gender: String,
    val imageUrl: String,
    val creatorName: String,
    val bannerImageUrl: String?,
    val isBanner: Boolean,
    val isAdult: Boolean,
    val isPublic: Boolean,
    val deleted: Boolean,
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

@Repository
class CharacterRepository(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
) {
    private val columns =
        "id, source_locale, name, tagline, first_message, personality, speech_style, world_setting, " +
            "gender, image_url, creator_name, banner_image_url, is_banner, is_adult, is_public, deleted_at"

    private fun json(
        rs: ResultSet,
        column: String,
    ): JsonNode = mapper.readTree(rs.getString(column))

    private val character =
        RowMapper { rs: ResultSet, _: Int ->
            CharacterRow(
                id = rs.getObject("id", UUID::class.java),
                sourceLocale = rs.getString("source_locale"),
                name = json(rs, "name"),
                tagline = json(rs, "tagline"),
                firstMessage = json(rs, "first_message"),
                personality = json(rs, "personality"),
                speechStyle = json(rs, "speech_style"),
                worldSetting = json(rs, "world_setting"),
                gender = rs.getString("gender"),
                imageUrl = rs.getString("image_url"),
                creatorName = rs.getString("creator_name"),
                bannerImageUrl = rs.getString("banner_image_url"),
                isBanner = rs.getBoolean("is_banner"),
                isAdult = rs.getBoolean("is_adult"),
                isPublic = rs.getBoolean("is_public"),
                deleted = rs.getObject("deleted_at") != null,
            )
        }

    fun find(id: UUID): CharacterRow? =
        jdbc
            .sql("SELECT $columns FROM characters WHERE id = :id")
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

    /** Live, public characters that may appear on the home page. */
    fun visibleCharacters(): List<CharacterRow> =
        jdbc.sql("SELECT $columns FROM characters WHERE deleted_at IS NULL AND is_public").query(character).list()

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
