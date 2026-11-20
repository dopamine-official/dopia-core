package com.dopia.chat

import com.dopia.character.ChatImage

/**
 * A reply places a situation image by writing `{{img::name}}`. The room keeps the picture's
 * address instead of its name, so a picture renamed later still shows in what was said before.
 */
object SceneImages {
    // Models do not always write the tag exactly: one colon, a space inside, another case.
    private val tag = Regex("""\{\{\s*img\s*::?\s*([^{}\n]*?)\s*\}\}""", RegexOption.IGNORE_CASE)

    // Stands where a tag was taken out, until its line is known to be empty or not.
    private const val GONE = "\u0000"
    private val emptiedLine = Regex("(^|\n)[ \t]*$GONE[ \t]*(?=\n|$)")

    private fun rewrite(
        text: String,
        replacement: (String) -> String?,
    ): String =
        tag
            .replace(text) { match -> replacement(match.groupValues[1])?.let { "{{img::$it}}" } ?: GONE }
            // A tag that had a line to itself takes the line with it, leaving no gap.
            .replace(emptiedLine, "")
            .replace(GONE, "")
            .trim()

    /**
     * What is saved and shown: each name becomes the picture's address. A name the character
     * does not have, and a second tag for a picture already in this reply, are taken out.
     */
    fun toStored(
        output: String,
        images: List<ChatImage>,
    ): String {
        // The model may change the case of a name; it is still that picture.
        val byName = images.associateBy { it.name.trim().lowercase() }
        val urls = images.map { it.imageUrl }.toSet()
        val used = mutableSetOf<String>()
        val stored =
            rewrite(output) { value ->
                // A model that has seen an address in an earlier reply may write one back.
                val url = byName[value.lowercase()]?.imageUrl ?: value.takeIf { it in urls }
                url?.takeIf(used::add)
            }
        // A reply that was nothing but tags we took out is kept as written; the web hides them.
        return stored.ifEmpty { output }
    }

    /** What the AI reads back: names again. A picture the character no longer has is left out. */
    fun toAi(
        content: String,
        images: List<ChatImage>,
    ): String {
        val byUrl = images.associateBy { it.imageUrl }
        return rewrite(content) { value -> byUrl[value]?.name }.ifEmpty { content }
    }
}
