package com.dopia

import com.dopia.character.CharacterCreators
import com.dopia.config.AppProperties
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.util.UUID

/** Who may make characters, as `app.character.creators` names them. */
class CharacterCreatorsTest {
    private val owner = UUID.randomUUID()
    private val other = UUID.randomUUID()

    private fun creators(value: String) = CharacterCreators(AppProperties(character = AppProperties.Character(creators = value)))

    @Test
    fun `only the listed accounts may create`() {
        val one = creators(owner.toString())
        assertEquals(true, one.allows(owner))
        assertEquals(false, one.allows(other))

        val two = creators(" $owner , ${other.toString().uppercase()} ")
        assertEquals(true, two.allows(owner))
        assertEquals(true, two.allows(other))
    }

    @Test
    fun `an empty list lets nobody create and a star lets everybody`() {
        assertEquals(false, creators("").allows(owner))
        assertEquals(true, creators("*").allows(owner))
    }

    @Test
    fun `a value that is not an account ID is skipped, not fatal`() {
        val mixed = creators("not-an-id,$owner")
        assertEquals(true, mixed.allows(owner))
        assertEquals(false, mixed.allows(other))
    }
}
