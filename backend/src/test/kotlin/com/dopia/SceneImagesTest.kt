package com.dopia

import com.dopia.character.ChatImage
import com.dopia.chat.SceneImages
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/** The room keeps a picture's address; the AI is told, and reads back, its name. */
class SceneImagesTest {
    private val images = listOf(ChatImage("hallway", "in the hallway", "/files/a.webp"), ChatImage("smile", "she smiles", "/files/b.webp"))

    @Test
    fun `a name becomes the picture's address when the reply is saved`() {
        assertEquals(
            "{{img::/files/a.webp}}\n*She waves.*\n{{img::/files/b.webp}}\nYou came.",
            SceneImages.toStored("{{img::hallway}}\n*She waves.*\n{{ IMG:Smile }}\nYou came.", images),
        )
        assertEquals("You came.", SceneImages.toStored("You came.", images))
    }

    @Test
    fun `a name the character does not have and a repeated picture are taken out`() {
        assertEquals(
            "{{img::/files/a.webp}}\none\ntwo\nthree",
            SceneImages.toStored("{{img::hallway}}\none\n{{img::rooftop}}\ntwo\n{{img::hallway}}\nthree", images),
        )
        // An address is kept only when it is one of this character's.
        assertEquals(
            "{{img::/files/a.webp}}\none",
            SceneImages.toStored("{{img::/files/a.webp}}\n{{img::https://else/x.png}}\none", images),
        )
        // Nothing left to save: the reply stays as written.
        assertEquals("{{img::rooftop}}", SceneImages.toStored("{{img::rooftop}}", images))
        assertEquals("one", SceneImages.toStored("{{img::hallway}}\none", emptyList()))
    }

    @Test
    fun `the AI reads names back, without a picture the character no longer has`() {
        val stored = "{{img::/files/a.webp}}\none\n{{img::/files/gone.webp}}\ntwo"
        assertEquals("{{img::hallway}}\none\ntwo", SceneImages.toAi(stored, images))
        // Taken out of the middle of a line, the rest of the line stays.
        assertEquals("one  two", SceneImages.toAi("one {{img::/files/gone.webp}} two", images))
        assertEquals("one", SceneImages.toAi("one", images))
    }
}
