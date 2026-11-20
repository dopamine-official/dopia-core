package com.dopia.character

import com.dopia.common.ApiException
import com.dopia.common.FieldError
import com.dopia.common.Identity
import com.dopia.common.RequestLocale
import com.dopia.common.RequiresMember
import org.springframework.http.CacheControl
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RequestPart
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.multipart.MultipartFile
import java.util.UUID

data class ImageUpdateRequest(
    val name: String?,
    val description: String?,
)

/** A creator's own characters and their images (CHARACTER 4-2). Every answer is for one account only. */
@RestController
@RequestMapping("/api/v1")
class CharacterController(
    private val editor: CharacterEditor,
) {
    private fun <T : Any> private(body: T): ResponseEntity<T> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore().cachePrivate()).body(body)

    private fun id(
        value: String,
        field: String = "character_id",
    ): UUID = runCatching { UUID.fromString(value) }.getOrElse { throw ApiException.invalidInput(FieldError(field, "invalid_value")) }

    private fun form(
        fields: Map<String, String>,
        thumbnail: MultipartFile?,
    ) = CharacterForm(fields["action"], fields, thumbnail?.takeIf { !it.isEmpty }?.bytes)

    @GetMapping("/creators/{creatorId}")
    fun creator(
        identity: Identity,
        locale: RequestLocale,
        @PathVariable creatorId: String,
    ) = private(editor.creatorProfile(identity, locale, id(creatorId, "creator_id")))

    @RequiresMember
    @GetMapping("/characters/mine")
    fun mine(identity: Identity) = private(editor.mine(identity))

    @RequiresMember
    @GetMapping("/characters/{characterId}")
    fun detail(
        identity: Identity,
        @PathVariable characterId: String,
    ) = private(editor.detail(identity, id(characterId)))

    @RequiresMember
    @PostMapping("/characters", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun create(
        identity: Identity,
        locale: RequestLocale,
        @RequestParam fields: Map<String, String>,
        @RequestPart(required = false) thumbnail: MultipartFile?,
    ) = private(editor.save(identity, locale, null, form(fields, thumbnail)))

    @RequiresMember
    @PatchMapping("/characters/{characterId}", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun update(
        identity: Identity,
        locale: RequestLocale,
        @PathVariable characterId: String,
        @RequestParam fields: Map<String, String>,
        @RequestPart(required = false) thumbnail: MultipartFile?,
    ) = private(editor.save(identity, locale, id(characterId), form(fields, thumbnail)))

    @RequiresMember
    @DeleteMapping("/characters/{characterId}")
    fun delete(
        identity: Identity,
        @PathVariable characterId: String,
    ): ResponseEntity<Void> {
        editor.delete(identity, id(characterId))
        return ResponseEntity.noContent().build()
    }

    @RequiresMember
    @PostMapping("/characters/{characterId}/images", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun addImage(
        identity: Identity,
        @PathVariable characterId: String,
        @RequestPart(required = false) file: MultipartFile?,
        @RequestParam(required = false) name: String?,
        @RequestParam(required = false) description: String?,
    ) = private(editor.addImage(identity, id(characterId), file?.bytes, name, description))

    @RequiresMember
    @PatchMapping("/characters/{characterId}/images/{imageId}", consumes = [MediaType.APPLICATION_JSON_VALUE])
    fun updateImage(
        identity: Identity,
        @PathVariable characterId: String,
        @PathVariable imageId: String,
        @RequestBody body: ImageUpdateRequest,
    ) = private(editor.updateImage(identity, id(characterId), id(imageId, "image_id"), body.name, body.description))

    @RequiresMember
    @DeleteMapping("/characters/{characterId}/images/{imageId}")
    fun deleteImage(
        identity: Identity,
        @PathVariable characterId: String,
        @PathVariable imageId: String,
    ): ResponseEntity<Void> {
        editor.deleteImage(identity, id(characterId), id(imageId, "image_id"))
        return ResponseEntity.noContent().build()
    }
}
