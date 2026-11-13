package com.dopia.account

import com.dopia.config.AppProperties
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

enum class ImageType(
    val extension: String,
) {
    PNG("png"),
    JPEG("jpg"),
    WEBP("webp"),
}

/** Detects the format from the file bytes, never from the name or Content-Type (5-1-2). */
fun detectImageType(bytes: ByteArray): ImageType? {
    fun at(index: Int) = bytes.getOrNull(index)?.toInt()?.and(0xff)
    return when {
        bytes.size >= 8 && at(0) == 0x89 && at(1) == 0x50 && at(2) == 0x4E && at(3) == 0x47 -> ImageType.PNG

        bytes.size >= 3 && at(0) == 0xFF && at(1) == 0xD8 && at(2) == 0xFF -> ImageType.JPEG

        bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" &&
            String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> ImageType.WEBP

        else -> null
    }
}

/** Public file storage for profile photos and character images. Local disk, or R2 when configured. */
interface PhotoStorage {
    /** Stores [bytes] under [key] and returns the public URL. A key is never written twice. */
    fun put(
        key: String,
        bytes: ByteArray,
        contentType: String,
    ): String

    /** Stores the file and returns its public URL. */
    fun store(
        accountId: UUID,
        bytes: ByteArray,
        type: ImageType,
    ): String

    /** Best effort removal of a previously returned URL. */
    fun delete(url: String)
}

@Component
class LocalDiskPhotoStorage(
    private val properties: AppProperties,
) : PhotoStorage {
    private val log = LoggerFactory.getLogger(LocalDiskPhotoStorage::class.java)
    val root: Path = Path.of(properties.storage.localDir).toAbsolutePath().normalize()

    override fun store(
        accountId: UUID,
        bytes: ByteArray,
        type: ImageType,
    ): String = put("profiles/$accountId-${UUID.randomUUID()}.${type.extension}", bytes, "")

    override fun put(
        key: String,
        bytes: ByteArray,
        contentType: String,
    ): String {
        val target = root.resolve(key).normalize()
        require(target.startsWith(root)) { "key leaves the storage root" }
        Files.createDirectories(target.parent)
        Files.write(target, bytes)
        return "${properties.storage.publicBaseUrl.trimEnd('/')}/$key"
    }

    override fun delete(url: String) {
        val base = properties.storage.publicBaseUrl.trimEnd('/') + "/"
        if (!url.startsWith(base)) return
        val target = root.resolve(url.removePrefix(base)).normalize()
        if (!target.startsWith(root)) return
        runCatching { Files.deleteIfExists(target) }.onFailure { log.warn("could not delete {}", target, it) }
    }
}
