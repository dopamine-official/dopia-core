package com.dopia.character

import com.dopia.account.ImageType
import com.dopia.account.detectImageType
import com.dopia.config.AppProperties
import com.sksamuel.scrimage.ImmutableImage
import com.sksamuel.scrimage.webp.WebpWriter
import org.springframework.stereotype.Component

/** The file is not an image we take: wrong format, animated, too many pixels or unreadable. */
class InvalidImage(
    reason: String,
) : RuntimeException(reason)

data class ImageSize(
    val width: Int,
    val height: Int,
)

/**
 * Reads the size from the file header, without decoding the pixels, so an image that would
 * expand to gigabytes is turned away first (CHARACTER 5-1-2). Null when the header is cut short
 * or the image is animated.
 */
fun readImageSize(
    bytes: ByteArray,
    type: ImageType,
): ImageSize? {
    fun u8(index: Int) = bytes[index].toInt() and 0xff

    fun be16(index: Int) = (u8(index) shl 8) or u8(index + 1)

    fun be32(index: Int) = (be16(index).toLong() shl 16) or be16(index + 2).toLong()

    fun le16(index: Int) = u8(index) or (u8(index + 1) shl 8)

    fun le24(index: Int) = le16(index) or (u8(index + 2) shl 16)

    fun tag(index: Int) = String(bytes, index, 4, Charsets.US_ASCII)
    return runCatching {
        when (type) {
            ImageType.PNG -> {
                // Chunks follow the 8 byte signature; an acTL chunk before the pixels marks an animation.
                var at = 8
                var size: ImageSize? = null
                while (at + 8 <= bytes.size) {
                    val length = be32(at)
                    // A length past the end of the file is a cut or forged file; it must not move `at` backwards.
                    if (length > bytes.size) return null
                    when (tag(at + 4)) {
                        "IHDR" -> size = ImageSize(be32(at + 8).toInt(), be32(at + 12).toInt())
                        "acTL" -> return null
                        "IDAT" -> return size
                    }
                    at += 12 + length.toInt()
                }
                null
            }

            ImageType.JPEG -> {
                var at = 2
                while (at + 4 <= bytes.size) {
                    if (u8(at) != 0xff) return null
                    val marker = u8(at + 1)
                    when {
                        marker == 0xff -> {
                            at += 1
                        }

                        // Markers that stand alone, with no length.
                        marker == 0x01 || marker in 0xd0..0xd8 -> {
                            at += 2
                        }

                        // Start of frame, except the three that are tables.
                        marker in 0xc0..0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc -> {
                            return ImageSize(be16(at + 7), be16(at + 5))
                        }

                        else -> {
                            at += 2 + be16(at + 2)
                        }
                    }
                }
                null
            }

            ImageType.WEBP -> {
                when (tag(12)) {
                    "VP8 " -> {
                        ImageSize(le16(26) and 0x3fff, le16(28) and 0x3fff)
                    }

                    "VP8L" -> {
                        val bits = le16(21).toLong() or (le16(23).toLong() shl 16)
                        ImageSize((bits and 0x3fff).toInt() + 1, ((bits shr 14) and 0x3fff).toInt() + 1)
                    }

                    // Bit 1 of the flags marks an animation.
                    "VP8X" -> {
                        if (u8(20) and 0x02 != 0) null else ImageSize(le24(24) + 1, le24(27) + 1)
                    }

                    else -> {
                        null
                    }
                }
            }
        }
    }.getOrNull()?.takeIf { it.width > 0 && it.height > 0 }
}

/** The chunks a png needs to be drawn. Everything else is dropped before decoding. */
private val PNG_DRAWING_CHUNKS = setOf("IHDR", "PLTE", "tRNS", "IDAT", "IEND")

/**
 * A png without its text, profile and other side chunks. A decoder inflates compressed text
 * chunks in full, so a small file could ask for gigabytes of memory. Null when a chunk runs
 * past the end of the file.
 */
fun stripPngSideChunks(bytes: ByteArray): ByteArray? {
    val out = java.io.ByteArrayOutputStream(bytes.size)
    out.write(bytes, 0, 8)
    var at = 8
    while (at + 12 <= bytes.size) {
        val length =
            ((bytes[at].toLong() and 0xff) shl 24) or ((bytes[at + 1].toLong() and 0xff) shl 16) or
                ((bytes[at + 2].toLong() and 0xff) shl 8) or (bytes[at + 3].toLong() and 0xff)
        if (length > bytes.size - at - 12) return null
        val whole = 12 + length.toInt()
        val type = String(bytes, at + 4, 4, Charsets.US_ASCII)
        if (type in PNG_DRAWING_CHUNKS) out.write(bytes, at, whole)
        at += whole
        if (type == "IEND") break
    }
    return out.toByteArray()
}

/**
 * Turns an upload into the webp we store (CHARACTER 3-1-3). The received file is never kept:
 * decoding and encoding again drops metadata and anything appended to the file.
 */
@Component
class ImageProcessor(
    properties: AppProperties,
) {
    private val settings = properties.character
    private val writer = WebpWriter.DEFAULT.withQ(85)

    /** A decoded image takes four bytes a pixel, so only a few are held in memory at once. */
    private val slots = java.util.concurrent.Semaphore(2)

    /** The centre square, at most `thumbnailMaxPx` on a side. */
    fun thumbnail(bytes: ByteArray): ByteArray =
        convert(bytes) { image ->
            val side = minOf(image.width, image.height)
            val square = image.cover(side, side)
            if (side > settings.thumbnailMaxPx) square.scaleTo(settings.thumbnailMaxPx, settings.thumbnailMaxPx) else square
        }

    /** The whole picture, its longer side at most `imageMaxPx`. Never scaled up. */
    fun picture(bytes: ByteArray): ByteArray = convert(bytes) { it.bound(settings.imageMaxPx, settings.imageMaxPx) }

    private fun convert(
        bytes: ByteArray,
        shape: (ImmutableImage) -> ImmutableImage,
    ): ByteArray {
        val type = detectImageType(bytes) ?: throw InvalidImage("not a jpeg, png or webp")
        val size = readImageSize(bytes, type) ?: throw InvalidImage("unreadable or animated")
        if (size.width.toLong() * size.height > settings.imageMaxPixels) throw InvalidImage("too many pixels")
        val drawing = if (type == ImageType.PNG) stripPngSideChunks(bytes) ?: throw InvalidImage("cut short") else bytes
        slots.acquire()
        return try {
            shape(ImmutableImage.loader().fromBytes(drawing)).bytes(writer)
        } catch (error: Exception) {
            throw InvalidImage("could not be decoded: ${error.message}")
        } finally {
            slots.release()
        }
    }
}
