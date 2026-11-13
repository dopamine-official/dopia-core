package com.dopia

import com.dopia.account.ImageType
import com.dopia.account.detectImageType
import com.dopia.character.ImageProcessor
import com.dopia.character.ImageSize
import com.dopia.character.InvalidImage
import com.dopia.character.readImageSize
import com.dopia.config.AppProperties
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/** CH-BE-14: what the image conversion stores, and what it turns away before decoding. */
class ImageProcessorTest {
    private val processor = ImageProcessor(AppProperties())

    private fun image(
        width: Int,
        height: Int,
        format: String,
    ): ByteArray {
        val picture = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val graphics = picture.createGraphics()
        graphics.color = java.awt.Color(80, 140, 200)
        graphics.fillRect(0, 0, width, height)
        graphics.dispose()
        return ByteArrayOutputStream().also { ImageIO.write(picture, format, it) }.toByteArray()
    }

    private fun stored(bytes: ByteArray): ImageSize {
        assertEquals(ImageType.WEBP, detectImageType(bytes))
        return readImageSize(bytes, ImageType.WEBP)!!
    }

    @Test
    fun `reads the size of a jpeg and a png from the header`() {
        assertEquals(ImageSize(768, 1024), readImageSize(image(768, 1024, "jpg"), ImageType.JPEG))
        assertEquals(ImageSize(300, 200), readImageSize(image(300, 200, "png"), ImageType.PNG))
        assertNull(readImageSize(image(300, 200, "png").copyOf(20), ImageType.PNG))
    }

    @Test
    fun `a thumbnail is the centre square, scaled down to the limit`() {
        assertEquals(ImageSize(768, 768), stored(processor.thumbnail(image(768, 1024, "jpg"))))
        assertEquals(ImageSize(1024, 1024), stored(processor.thumbnail(image(3000, 2000, "png"))))
        // A stored webp goes through again unchanged in size.
        assertEquals(ImageSize(768, 768), stored(processor.thumbnail(processor.thumbnail(image(768, 1024, "jpg")))))
    }

    @Test
    fun `a picture keeps its shape and is never scaled up`() {
        assertEquals(ImageSize(2048, 1365), stored(processor.picture(image(3000, 2000, "png"))))
        assertEquals(ImageSize(300, 200), stored(processor.picture(image(300, 200, "png"))))
    }

    @Test
    fun `turns away other formats, animations, cut files and oversized headers`() {
        assertFailsWith<InvalidImage> { processor.thumbnail(image(10, 10, "gif")) }
        assertFailsWith<InvalidImage> { processor.thumbnail(image(300, 200, "png").copyOf(40)) }
        // An animated png: an acTL chunk before the pixels.
        val png = image(10, 10, "png")
        val actl = byteArrayOf(0, 0, 0, 8) + "acTL".toByteArray() + ByteArray(8) + ByteArray(4)
        assertFailsWith<InvalidImage> { processor.thumbnail(png.copyOfRange(0, 33) + actl + png.copyOfRange(33, png.size)) }
        // A header that claims 40000 x 40000 is refused without decoding.
        val huge = image(10, 10, "png")
        huge[16] = 0
        huge[17] = 0
        huge[18] = 0x9c.toByte()
        huge[19] = 0x40
        huge[20] = 0
        huge[21] = 0
        huge[22] = 0x9c.toByte()
        huge[23] = 0x40
        assertFailsWith<InvalidImage> { processor.thumbnail(huge) }
        // A text chunk that inflates to 1.5 GB is dropped before decoding, not inflated.
        val zeros =
            ByteArrayOutputStream()
                .also { out ->
                    java.util.zip
                        .DeflaterOutputStream(out)
                        .use { deflater -> repeat(1500) { deflater.write(ByteArray(1 shl 20)) } }
                }.toByteArray()
        val data = "a".toByteArray() + byteArrayOf(0, 0) + zeros
        val crc =
            java.util.zip
                .CRC32()
                .also { it.update("zTXt".toByteArray() + data) }
                .value
                .toInt()

        fun int(value: Int) = byteArrayOf((value shr 24).toByte(), (value shr 16).toByte(), (value shr 8).toByte(), value.toByte())
        val bomb = png.copyOfRange(0, 33) + int(data.size) + "zTXt".toByteArray() + data + int(crc) + png.copyOfRange(33, png.size)
        assertEquals(ImageSize(10, 10), stored(processor.picture(bomb)))
        // A chunk length that wraps to a negative step once looped forever.
        val wrap = image(10, 10, "png").copyOf(8) + byteArrayOf(-1, -1, -1, 0xf4.toByte()) + "tEXt".toByteArray() + ByteArray(32)
        org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(java.time.Duration.ofSeconds(3)) {
            assertNull(readImageSize(wrap, ImageType.PNG))
        }
    }
}
