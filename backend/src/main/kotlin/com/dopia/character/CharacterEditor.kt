package com.dopia.character

import com.dopia.account.AccountRepository
import com.dopia.account.PhotoStorage
import com.dopia.common.ApiException
import com.dopia.common.FeatureFlags
import com.dopia.common.FieldError
import com.dopia.common.I18n
import com.dopia.common.Identity
import com.dopia.common.RequestLocale
import com.dopia.config.AppProperties
import org.slf4j.LoggerFactory
import org.springframework.dao.DuplicateKeyException
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant
import java.util.UUID

// Responses for the creator (4-2-4, 4-2-5, 4-2-13) and the creator profile (4-2-3)
data class CharacterImageView(
    val id: UUID,
    val name: String,
    val description: String,
    val imageUrl: String,
    val position: Int,
)

data class CharacterDetail(
    val id: UUID,
    val status: String,
    /** pending or rejected while a public character has a revision; otherwise null. */
    val revisionStatus: String?,
    val rejectionReason: String?,
    val name: String?,
    val characterName: String?,
    val tagline: String?,
    val personality: String?,
    val speechStyle: String?,
    val worldSetting: String?,
    val firstMessage: String?,
    val statusWindowEnabled: Boolean,
    val statusWindowFormat: String?,
    val statusWindowInitial: String?,
    val statusWindowRules: String?,
    val gender: String?,
    val age: Int?,
    val isAdult: Boolean,
    val imageUrl: String?,
    val images: List<CharacterImageView>,
    val updatedAt: Instant,
)

data class MyCharacter(
    val id: UUID,
    val name: String?,
    val imageUrl: String?,
    val status: String,
    val revisionStatus: String?,
    val rejectionReason: String?,
    val updatedAt: Instant,
)

data class MyCharacters(
    val characters: List<MyCharacter>,
)

data class CreatorCharacter(
    val id: UUID,
    val name: String,
    val tagline: String,
    val imageUrl: String,
)

data class CreatorProfile(
    val creatorId: UUID,
    val nickname: String,
    val photoUrl: String?,
    val characters: List<CreatorCharacter>,
)

/** One create or update request (4-2-6). A field that was not sent is null and stays as it is. */
data class CharacterForm(
    val action: String?,
    /** Raw request fields by name. */
    val fields: Map<String, String>,
    val thumbnail: ByteArray?,
)

/** Removes what a text field must not carry and returns it trimmed (5-1-2). */
fun cleanText(value: String): String =
    value
        .replace("\r\n", "\n")
        .replace('\r', '\n')
        .filter { it == '\n' || it == '\t' || !it.isISOControl() }
        .trim()

/** Length as the creator sees it: code points, so an emoji counts once. */
fun textLength(value: String): Int = value.codePointCount(0, value.length)

/** Creating, saving, submitting and deleting a member's own characters, and their images (4-1-2, 4-1-3, 4-1-8). */
@Service
class CharacterEditor(
    private val repository: CharacterRepository,
    private val characters: CharacterService,
    private val accounts: AccountRepository,
    private val flags: FeatureFlags,
    private val processor: ImageProcessor,
    private val storage: PhotoStorage,
    private val properties: AppProperties,
    private val tx: TransactionTemplate,
) {
    private val log = LoggerFactory.getLogger(CharacterEditor::class.java)
    private val settings = properties.character

    private val limits =
        mapOf(
            "name" to 30,
            "character_name" to 30,
            "tagline" to 35,
            "personality" to 2000,
            "speech_style" to 2000,
            "world_setting" to 6000,
            "first_message" to 3000,
            "status_window_format" to 500,
            "status_window_initial" to 500,
            "status_window_rules" to 1000,
        )

    /** What a submitted character must have, apart from the status window pair. */
    private val required = listOf("name", "character_name", "tagline", "personality", "speech_style", "world_setting", "first_message")

    private fun assertEnabled(identity: Identity) {
        if (!flags.enabled("character_creation_enabled", identity.accountId)) {
            throw ApiException("creation_disabled", HttpStatus.FORBIDDEN, message = "character creation is turned off")
        }
    }

    private fun notFound() = ApiException("character_not_found", HttpStatus.NOT_FOUND, message = "no such character")

    private fun owned(
        row: CharacterRow?,
        identity: Identity,
    ): CharacterRow {
        if (row == null || row.deleted) throw notFound()
        if (row.creatorId != identity.accountId) throw ApiException("not_owner", HttpStatus.FORBIDDEN, message = "not your character")
        return row
    }

    private fun saveNotAllowed() =
        ApiException("save_not_allowed", HttpStatus.CONFLICT, message = "a character under review or public takes only a submit")

    private fun text(
        row: CharacterRow,
        value: tools.jackson.databind.JsonNode,
    ): String = value.path(row.sourceLocale).asString("")

    private fun rowTexts(row: CharacterRow): Map<String, String> =
        mapOf(
            "name" to text(row, row.name),
            "character_name" to text(row, row.characterName),
            "tagline" to text(row, row.tagline),
            "personality" to text(row, row.personality),
            "speech_style" to text(row, row.speechStyle),
            "world_setting" to text(row, row.worldSetting),
            "first_message" to text(row, row.firstMessage),
            "status_window_format" to text(row, row.statusWindowFormat),
            "status_window_initial" to text(row, row.statusWindowInitial),
            "status_window_rules" to text(row, row.statusWindowRules),
        )

    /** [live] is the `characters` row; a revision, when there is one, supplies the content (4-1-3). */
    private fun detail(live: CharacterRow): CharacterDetail {
        val revision = if (live.approved) repository.revision(live.id) else null
        val row = live.with(revision)
        val texts = rowTexts(row).mapValues { it.value.ifEmpty { null } }
        return CharacterDetail(
            id = row.id,
            status = row.status,
            revisionStatus = revision?.status,
            rejectionReason = revision?.rejectionReason ?: row.rejectionReason,
            name = texts["name"],
            characterName = texts["character_name"],
            tagline = texts["tagline"],
            personality = texts["personality"],
            speechStyle = texts["speech_style"],
            worldSetting = texts["world_setting"],
            firstMessage = texts["first_message"],
            statusWindowEnabled = row.statusWindowEnabled,
            statusWindowFormat = texts["status_window_format"],
            statusWindowInitial = texts["status_window_initial"],
            statusWindowRules = texts["status_window_rules"],
            gender = row.gender,
            age = row.age,
            isAdult = row.isAdult,
            imageUrl = row.imageUrl,
            images = repository.images(row.id).map(::view),
            updatedAt = row.updatedAt,
        )
    }

    private fun view(image: CharacterImageRow) = CharacterImageView(image.id, image.name, image.description, image.imageUrl, image.position)

    fun mine(identity: Identity): MyCharacters =
        tx.execute {
            val rows = repository.mine(identity.accountId)
            val revisions = repository.revisions(rows.filter { it.approved }.map { it.id })
            MyCharacters(
                rows.map { live ->
                    val revision = revisions[live.id]
                    val row = live.with(revision)
                    MyCharacter(
                        row.id,
                        text(row, row.name).ifEmpty { null },
                        row.imageUrl,
                        row.status,
                        revision?.status,
                        revision?.rejectionReason ?: row.rejectionReason,
                        row.updatedAt,
                    )
                },
            )
        }!!

    fun detail(
        identity: Identity,
        id: UUID,
    ): CharacterDetail = tx.execute { detail(owned(repository.find(id), identity)) }!!

    /** Reads the request into a change, or throws 422 naming every field that is wrong. */
    private fun parse(form: CharacterForm): CharacterChange {
        val errors = mutableListOf<FieldError>()
        if (form.action != "save" && form.action != "submit") errors += FieldError("action", "invalid_value")
        val texts =
            limits
                .mapNotNull { (field, limit) ->
                    val value = form.fields[field]?.let(::cleanText) ?: return@mapNotNull null
                    if (textLength(value) > limit) errors += FieldError(field, "too_long")
                    field to value
                }.toMap()
        val gender =
            form.fields["gender"]?.trim()?.let {
                if (it.isNotEmpty() && it != "female" && it != "male") errors += FieldError("gender", "invalid_value")
                CharacterChange.Value(it.ifEmpty { null })
            }
        val age =
            form.fields["age"]?.trim()?.let {
                // Decimal digits only: no sign, no fraction, no other script's numerals.
                val valid = it.isEmpty() || Regex("[0-9]{1,5}").matches(it)
                if (!valid) errors += FieldError("age", "invalid_value")
                CharacterChange.Value(if (valid && it.isNotEmpty()) it.toInt() else null)
            }

        fun flag(field: String): Boolean? =
            when (form.fields[field]?.trim()) {
                null -> {
                    null
                }

                "true" -> {
                    true
                }

                "false" -> {
                    false
                }

                else -> {
                    errors += FieldError(field, "invalid_value")
                    null
                }
            }
        val statusWindowEnabled = flag("status_window_enabled")
        val isAdult = flag("is_adult")
        if (errors.isNotEmpty()) throw ApiException.invalidInput(*errors.toTypedArray())
        return CharacterChange(texts, gender, age, statusWindowEnabled, isAdult, submit = form.action == "submit")
    }

    private fun convert(
        bytes: ByteArray,
        field: String,
        shape: (ByteArray) -> ByteArray,
    ): ByteArray {
        if (bytes.size > settings.imageMaxBytes) {
            throw ApiException(
                "file_too_large",
                HttpStatus.PAYLOAD_TOO_LARGE,
                listOf(FieldError(field, "too_large")),
                "image exceeds the size limit",
            )
        }
        return try {
            shape(bytes)
        } catch (error: InvalidImage) {
            throw ApiException(
                "invalid_input",
                HttpStatus.UNPROCESSABLE_CONTENT,
                listOf(FieldError(field, "invalid_image")),
                "image rejected: ${error.message}",
            )
        }
    }

    /** Checks the character as it will be after this save (4-1-2 steps 4 and 5). */
    private fun validate(
        identity: Identity,
        current: CharacterRow,
        change: CharacterChange,
        hasImage: Boolean,
    ) {
        if (!change.submit && (current.status == "pending" || current.status == "approved")) throw saveNotAllowed()
        val texts = rowTexts(current) + change.texts
        val gender = if (change.gender != null) change.gender.value else current.gender
        val age = if (change.age != null) change.age.value else current.age
        val statusWindow = change.statusWindowEnabled ?: current.statusWindowEnabled
        val isAdult = change.isAdult ?: current.isAdult
        if (isAdult && !identity.adultVerified) {
            throw ApiException("adult_verification_required", HttpStatus.FORBIDDEN, message = "adult characters need adult verification")
        }
        val errors = mutableListOf<FieldError>()
        if (statusWindow && texts.getValue("status_window_format").isEmpty()) errors += FieldError("status_window_format", "required")
        if (isAdult && (age == null || age < settings.adultMinAge)) errors += FieldError("is_adult", "age_too_low")
        if (change.submit) {
            required.filter { texts.getValue(it).isEmpty() }.forEach { errors += FieldError(it, "required") }
            if (gender == null) errors += FieldError("gender", "required")
            if (age == null) errors += FieldError("age", "required")
            if (!hasImage) errors += FieldError("thumbnail", "required")
            if (statusWindow && texts.getValue("status_window_initial").isEmpty()) errors += FieldError("status_window_initial", "required")
        }
        if (errors.isNotEmpty()) throw ApiException.invalidInput(*errors.distinct().toTypedArray())
    }

    /** Create (id null) or update. Returns the character as saved. */
    fun save(
        identity: Identity,
        locale: RequestLocale,
        id: UUID?,
        form: CharacterForm,
    ): CharacterDetail {
        assertEnabled(identity)
        val change = parse(form)
        val thumbnail = form.thumbnail?.let { convert(it, "thumbnail", processor::thumbnail) }
        var uploaded: String? = null
        var replaced: String? = null
        try {
            val saved =
                tx.execute {
                    val characterId = id ?: repository.insert(identity.accountId, locale.locale)
                    val live = owned(repository.lock(characterId), identity)
                    // A public character is edited through its revision; what is public stays (4-1-2).
                    val revision = if (live.approved) repository.revision(characterId) else null
                    val current = live.with(revision)
                    validate(identity, current, change, hasImage = thumbnail != null || current.imageUrl != null)
                    if (thumbnail != null) {
                        uploaded = storage.put("characters/$characterId/thumbnail-${UUID.randomUUID()}.webp", thumbnail, "image/webp")
                    }
                    if (live.approved) {
                        // validate() let only a submit through, and a submit is complete.
                        repository.saveRevision(
                            characterId,
                            live.sourceLocale,
                            texts = rowTexts(current) + change.texts,
                            statusWindowEnabled = change.statusWindowEnabled ?: current.statusWindowEnabled,
                            gender = (if (change.gender != null) change.gender.value else current.gender)!!,
                            age = (if (change.age != null) change.age.value else current.age)!!,
                            imageUrl = uploaded ?: current.imageUrl!!,
                            isAdult = change.isAdult ?: current.isAdult,
                        )
                        repository.touch(characterId)
                        // The file of the revision this one replaces, unless it is the public thumbnail.
                        if (uploaded != null) replaced = revision?.imageUrl?.takeIf { it != live.imageUrl }
                    } else {
                        if (uploaded != null) replaced = current.imageUrl
                        repository.update(characterId, current.sourceLocale, change.copy(imageUrl = uploaded))
                        if (id != null && change == CharacterChange()) repository.touch(characterId)
                    }
                    detail(repository.find(characterId)!!)
                }!!
            // The old file goes only after the new one is saved (3-1-3). Failing to delete is logged, not an error.
            replaced?.let(storage::delete)
            return saved
        } catch (error: Exception) {
            uploaded?.let(storage::delete)
            throw error
        }
    }

    fun delete(
        identity: Identity,
        id: UUID,
    ) {
        val revisionFile =
            tx.execute {
                val live = owned(repository.lock(id), identity)
                // The thumbnail of an edit that was never approved goes with it; the rest stays for rooms.
                val file = repository.revision(id)?.imageUrl?.takeIf { it != live.imageUrl }
                repository.softDelete(id)
                listOfNotNull(file)
            }!!
        revisionFile.forEach(storage::delete)
        characters.clearCache()
    }

    /** Drops the revision of a public character; what is public is untouched (4-2-7). */
    fun cancelRevision(
        identity: Identity,
        id: UUID,
    ) {
        val file =
            tx.execute {
                val live = owned(repository.lock(id), identity)
                val revision =
                    repository.revision(id)
                        ?: throw ApiException("revision_not_found", HttpStatus.NOT_FOUND, message = "this character has no revision")
                repository.deleteRevision(id)
                repository.touch(id)
                listOfNotNull(revision.imageUrl.takeIf { it != live.imageUrl })
            }!!
        file.forEach(storage::delete)
    }

    private fun editable(
        identity: Identity,
        characterId: UUID,
    ): CharacterRow {
        val row = owned(repository.lock(characterId), identity)
        // Pictures of a character under review or public do not change without a review (2-2).
        if (row.status == "pending" || row.status == "approved") throw saveNotAllowed()
        return row
    }

    private fun imageName(value: String?): String {
        val name = value?.let(::cleanText).orEmpty().replace('\n', ' ')
        if (name.isEmpty()) throw ApiException.invalidInput(FieldError("name", "required"))
        if (textLength(name) > 40) throw ApiException.invalidInput(FieldError("name", "too_long"))
        return name
    }

    private fun imageDescription(value: String?): String {
        val description = value?.let(::cleanText).orEmpty()
        if (textLength(description) > 200) throw ApiException.invalidInput(FieldError("description", "too_long"))
        return description
    }

    private fun imageNotFound() = ApiException("image_not_found", HttpStatus.NOT_FOUND, message = "no such image on this character")

    fun addImage(
        identity: Identity,
        characterId: UUID,
        file: ByteArray?,
        name: String?,
        description: String?,
    ): CharacterImageView {
        assertEnabled(identity)
        val cleanName = imageName(name)
        val cleanDescription = imageDescription(description)
        if (file == null || file.isEmpty()) throw ApiException.invalidInput(FieldError("file", "required"))
        val picture = convert(file, "file", processor::picture)
        var uploaded: String? = null
        try {
            return tx.execute {
                editable(identity, characterId)
                val existing = repository.images(characterId)
                if (existing.size >= settings.imageMaxCount) {
                    throw ApiException(
                        "image_limit_reached",
                        HttpStatus.CONFLICT,
                        message = "a character holds at most ${settings.imageMaxCount} images",
                    )
                }
                if (existing.any { it.name == cleanName }) throw ApiException.invalidInput(FieldError("name", "duplicate"))
                uploaded = storage.put("characters/$characterId/images/${UUID.randomUUID()}.webp", picture, "image/webp")
                val row = repository.insertImage(characterId, cleanName, cleanDescription, uploaded!!)
                repository.touch(characterId)
                view(row)
            }!!
        } catch (error: Exception) {
            uploaded?.let(storage::delete)
            throw error
        }
    }

    fun updateImage(
        identity: Identity,
        characterId: UUID,
        imageId: UUID,
        name: String?,
        description: String?,
    ): CharacterImageView {
        assertEnabled(identity)
        return tx.execute {
            editable(identity, characterId)
            val current = repository.findImage(characterId, imageId) ?: throw imageNotFound()
            val newName = if (name == null) current.name else imageName(name)
            val newDescription = if (description == null) current.description else imageDescription(description)
            if (newName != current.name && repository.images(characterId).any { it.name == newName }) {
                throw ApiException.invalidInput(FieldError("name", "duplicate"))
            }
            try {
                repository.updateImage(imageId, newName, newDescription)
            } catch (error: DuplicateKeyException) {
                throw ApiException.invalidInput(FieldError("name", "duplicate"))
            }
            repository.touch(characterId)
            view(current.copy(name = newName, description = newDescription))
        }!!
    }

    fun deleteImage(
        identity: Identity,
        characterId: UUID,
        imageId: UUID,
    ) {
        assertEnabled(identity)
        val url =
            tx.execute {
                editable(identity, characterId)
                val current = repository.findImage(characterId, imageId) ?: throw imageNotFound()
                repository.deleteImage(imageId)
                repository.touch(characterId)
                current.imageUrl
            }!!
        storage.delete(url)
    }

    /** A creator's public characters, for anyone (4-1-3). */
    fun creatorProfile(
        identity: Identity,
        locale: RequestLocale,
        creatorId: UUID,
    ): CreatorProfile {
        val (nickname, photoUrl) =
            accounts.profiles(listOf(creatorId))[creatorId]
                ?: throw ApiException("creator_not_found", HttpStatus.NOT_FOUND, message = "no such creator")
        val adultAllowed = characters.adultAllowed(identity, locale)
        return CreatorProfile(
            creatorId,
            nickname,
            photoUrl,
            repository.approvedBy(creatorId).filter { adultAllowed || !it.isAdult }.map {
                CreatorCharacter(
                    it.id,
                    I18n.resolveText(it.name, it.sourceLocale, locale.locale),
                    I18n.resolveText(it.tagline, it.sourceLocale, locale.locale),
                    it.imageUrl.orEmpty(),
                )
            },
        )
    }
}
