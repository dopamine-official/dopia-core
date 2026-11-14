package com.dopia

import com.dopia.account.AccountService
import com.dopia.character.CharacterService
import com.dopia.common.FeatureFlags
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.test.context.ActiveProfiles
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.net.CookieManager
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.UUID
import javax.imageio.ImageIO
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** CHARACTER 5-5: a member makes, saves, submits and deletes characters and their images. */
@Import(TestcontainersConfiguration::class)
// Local disk even when backend/.env.local names an R2 bucket: a test must not write to a real bucket.
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = ["STORAGE_MODE=local"])
@ActiveProfiles("dev")
class CharacterCreationTest(
    @LocalServerPort private val port: Int,
    @Autowired private val accounts: AccountService,
    @Autowired private val characters: CharacterService,
    @Autowired private val flags: FeatureFlags,
    @Autowired private val jdbc: JdbcClient,
) {
    private val mapper = ObjectMapper()

    private fun picture(
        width: Int,
        height: Int,
        format: String = "png",
    ): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        return ByteArrayOutputStream().also { ImageIO.write(image, format, it) }.toByteArray()
    }

    private val everything =
        mapOf(
            "name" to "눈 내리는 도시",
            "character_name" to "겨울",
            "tagline" to "한 줄 소개",
            "gender" to "female",
            "age" to "23",
            "personality" to "무뚝뚝함",
            "speech_style" to "반말",
            "world_setting" to "겨울의 도시",
            "first_message" to "*다가온다.*\n또 만났네.",
        )

    private inner class Browser {
        private val client = HttpClient.newBuilder().cookieHandler(CookieManager()).build()
        var session: String? = null
        lateinit var memberId: String

        fun login(): Browser {
            val guest = send("POST", "/account/guest").let { mapper.readTree(it.body()).get("account_id").asString() }
            send("POST", "/account/me/consents", AGREE_ALL.toByteArray(), "application/json")
            val (member, token) = accounts.loginFresh(UUID.fromString(guest))
            session = token
            memberId = member
            return this
        }

        fun verifyAdult(): Browser {
            val response =
                send(
                    "POST",
                    "/account/me/adult_verification",
                    """{"gender":"male","birth_date":"1990-01-01"}""".toByteArray(),
                    "application/json",
                )
            assertEquals(200, response.statusCode(), response.body())
            return this
        }

        fun send(
            method: String,
            path: String,
            body: ByteArray? = null,
            type: String? = null,
        ): HttpResponse<String> {
            val request =
                HttpRequest
                    .newBuilder(URI("http://127.0.0.1:$port/api/v1$path"))
                    .header("X-Locale", "ko-KR")
                    .apply { session?.let { header("Cookie", "session=$it") } }
                    .method(method, body?.let { HttpRequest.BodyPublishers.ofByteArray(it) } ?: HttpRequest.BodyPublishers.noBody())
                    .apply { if (type != null) header("Content-Type", type) }
                    .build()
            return client.send(request, HttpResponse.BodyHandlers.ofString())
        }

        /** A multipart request: text fields and, by part name, files. */
        fun multipart(
            method: String,
            path: String,
            fields: Map<String, String>,
            files: Map<String, ByteArray> = emptyMap(),
        ): HttpResponse<String> {
            val boundary = "----test${UUID.randomUUID()}"
            val out = ByteArrayOutputStream()
            fields.forEach { (name, value) ->
                out.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray())
            }
            files.forEach { (name, bytes) ->
                out.write(
                    "--$boundary\r\nContent-Disposition: form-data; name=\"$name\"; filename=\"f\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                        .toByteArray(),
                )
                out.write(bytes)
                out.write("\r\n".toByteArray())
            }
            out.write("--$boundary--\r\n".toByteArray())
            return send(method, path, out.toByteArray(), "multipart/form-data; boundary=$boundary")
        }

        fun save(
            fields: Map<String, String>,
            id: String? = null,
            action: String = "save",
            thumbnail: ByteArray? = null,
        ) = multipart(
            if (id == null) "POST" else "PATCH",
            if (id == null) "/characters" else "/characters/$id",
            fields + ("action" to action),
            thumbnail?.let { mapOf("thumbnail" to it) } ?: emptyMap(),
        )

        /** A complete character, submitted for review. */
        fun submitted(extra: Map<String, String> = emptyMap()): String {
            val response = save(everything + extra, action = "submit", thumbnail = picture(64, 64))
            assertEquals(200, response.statusCode(), response.body())
            return json(response).get("id").asString()
        }
    }

    private fun json(response: HttpResponse<String>): JsonNode = mapper.readTree(response.body())

    /** The field errors of a 422, as field to reason. */
    private fun errors(response: HttpResponse<String>): Map<String, String> {
        assertEquals(422, response.statusCode(), response.body())
        return json(response).get("detail").associate { it.get("field").asString() to it.get("reason").asString() }
    }

    private fun code(response: HttpResponse<String>) = response.statusCode() to json(response).get("code").asString()

    private fun approve(id: String) {
        jdbc.sql("UPDATE characters SET status = 'approved' WHERE id = :id").param("id", UUID.fromString(id)).update()
        characters.clearCache()
    }

    @Test
    fun `only a member with the flag on makes a character, and a draft keeps what was sent`() {
        val guest = Browser()
        guest.send("POST", "/account/guest")
        assertEquals(403, guest.save(mapOf("name" to "x")).statusCode())

        val member = Browser().login()
        flags.overrides["character_creation_enabled"] = false
        try {
            assertEquals(403 to "creation_disabled", code(member.save(mapOf("name" to "x"))))
        } finally {
            flags.overrides["character_creation_enabled"] = true
        }

        // CH-BE-13: only the fields that were sent change, and an empty text clears one.
        val created = json(member.save(mapOf("name" to "  겨울  ")))
        assertEquals("draft", created.get("status").asString())
        assertEquals("겨울", created.get("name").asString())
        assertTrue(created.get("personality").isNull && created.get("age").isNull && created.get("image_url").isNull)
        val id = created.get("id").asString()
        val second = json(member.save(mapOf("personality" to "무뚝뚝함", "age" to "23"), id))
        assertEquals("겨울", second.get("name").asString())
        assertEquals("무뚝뚝함", second.get("personality").asString())
        assertEquals(23, second.get("age").asInt())
        val third = json(member.save(mapOf("name" to "", "age" to ""), id))
        assertTrue(third.get("name").isNull && third.get("age").isNull)
        assertEquals("무뚝뚝함", third.get("personality").asString())

        val mine = json(member.send("GET", "/characters/mine")).get("characters")
        assertEquals(1, mine.size())
        assertTrue(mine.get(0).get("name").isNull)
        assertEquals(
            "no-store, private",
            member
                .send("GET", "/characters/mine")
                .headers()
                .firstValue("Cache-Control")
                .get(),
        )
    }

    @Test
    fun `values are checked when saved and everything is needed to submit`() {
        val member = Browser().login()
        // CH-BE-16, CH-BE-29
        assertEquals(mapOf("name" to "too_long"), errors(member.save(mapOf("name" to "가".repeat(31)))))
        assertEquals(200, member.save(mapOf("name" to " " + "😀".repeat(30) + " ")).statusCode())
        listOf("-1", "100000", "1.5", "스물", "２３").forEach {
            assertEquals(mapOf("age" to "invalid_value"), errors(member.save(mapOf("age" to it))), it)
        }
        assertEquals(mapOf("gender" to "invalid_value"), errors(member.save(mapOf("gender" to "other"))))
        assertEquals(mapOf("action" to "invalid_value"), errors(member.multipart("POST", "/characters", mapOf("name" to "x"))))

        // CH-BE-17: a submit names every missing field and saves nothing.
        val draft = json(member.save(mapOf("name" to "겨울", "personality" to "p"))).get("id").asString()
        val missing = errors(member.save(emptyMap(), draft, action = "submit"))
        assertEquals(
            setOf("character_name", "tagline", "speech_style", "world_setting", "first_message", "gender", "age", "thumbnail"),
            missing.keys,
        )
        assertTrue(missing.values.all { it == "required" })
        assertEquals("draft", json(member.send("GET", "/characters/$draft")).get("status").asString())

        val done = json(member.save(everything - "name" - "personality", draft, action = "submit", thumbnail = picture(300, 200)))
        assertEquals("pending", done.get("status").asString())
        assertTrue(done.get("image_url").asString().contains("/characters/$draft/thumbnail-"))
        assertTrue(done.get("image_url").asString().endsWith(".webp"))

        // CH-BE-18: under review or public takes a submit only; a submit of a public one stays public.
        assertEquals(409 to "save_not_allowed", code(member.save(mapOf("name" to "새 이름"), draft)))
        approve(draft)
        assertEquals(409 to "save_not_allowed", code(member.save(mapOf("name" to "새 이름"), draft)))
        val edited = json(member.save(mapOf("name" to "새 이름"), draft, action = "submit"))
        assertEquals("approved", edited.get("status").asString())
        assertEquals("pending", edited.get("revision_status").asString())
    }

    @Test
    fun `a thumbnail is checked, converted and replaced`() {
        val member = Browser().login()
        // CH-BE-14
        assertEquals(mapOf("thumbnail" to "invalid_image"), errors(member.save(emptyMap(), thumbnail = picture(10, 10, "gif"))))
        assertEquals(mapOf("thumbnail" to "invalid_image"), errors(member.save(emptyMap(), thumbnail = picture(300, 200).copyOf(40))))
        assertEquals(413, member.save(emptyMap(), thumbnail = picture(10, 10) + ByteArray(5 * 1024 * 1024)).statusCode())

        val created = json(member.save(emptyMap(), thumbnail = picture(300, 200, "jpg")))
        val id = created.get("id").asString()
        val first = created.get("image_url").asString()
        val second = json(member.save(emptyMap(), id, thumbnail = picture(64, 64))).get("image_url").asString()
        assertTrue(first != second)

        // CH-BE-15: the old file is gone and the new one is served.
        fun served(url: String) =
            HttpClient
                .newHttpClient()
                .send(
                    HttpRequest.newBuilder(URI("http://127.0.0.1:$port$url")).build(),
                    HttpResponse.BodyHandlers.discarding(),
                ).statusCode()
        assertEquals(404, served(first))
        assertEquals(200, served(second))
    }

    @Test
    fun `an adult character needs a verified creator and a character of twenty or more`() {
        // CH-BE-19
        val plain = Browser().login()
        assertEquals(403 to "adult_verification_required", code(plain.save(mapOf("age" to "25", "is_adult" to "true"))))

        // CH-BE-30
        val verified = Browser().login().verifyAdult()
        assertEquals(mapOf("is_adult" to "age_too_low"), errors(verified.save(mapOf("age" to "19", "is_adult" to "true"))))
        assertEquals(mapOf("is_adult" to "age_too_low"), errors(verified.save(mapOf("is_adult" to "true"))))
        val id = json(verified.save(mapOf("age" to "20", "is_adult" to "true"))).get("id").asString()
        assertEquals(mapOf("is_adult" to "age_too_low"), errors(verified.save(mapOf("age" to "19"), id)))
        assertEquals(200, verified.save(mapOf("age" to "19", "is_adult" to "false"), id).statusCode())
        // The console cannot do it either.
        jdbc.sql("UPDATE characters SET age = 20, is_adult = true WHERE id = :id").param("id", UUID.fromString(id)).update()
        assertFailsWith<DataIntegrityViolationException> {
            jdbc.sql("UPDATE characters SET age = 19 WHERE id = :id").param("id", UUID.fromString(id)).update()
        }
    }

    @Test
    fun `the first status values reach chat inside the tags, only while the status window is on`() {
        // CH-BE-31
        val member = Browser().login()
        val window = mapOf("status_window_enabled" to "true", "status_window_format" to "관계: <단계>")
        assertEquals(mapOf("status_window_format" to "required"), errors(member.save(mapOf("status_window_enabled" to "true"))))
        val id = json(member.save(everything + window, thumbnail = picture(64, 64))).get("id").asString()
        assertEquals(mapOf("status_window_initial" to "required"), errors(member.save(emptyMap(), id, action = "submit")))
        assertEquals(200, member.save(mapOf("status_window_initial" to " 관계: 아는 사이 "), id, action = "submit").statusCode())

        val uuid = UUID.fromString(id)
        val chat = characters.forChat(uuid, "ko-KR", adultAllowed = false)
        assertEquals("*다가온다.*\n또 만났네.\n<status>\n관계: 아는 사이\n</status>", chat.firstMessage)
        assertEquals(23, chat.age)
        assertEquals("겨울", chat.characterName)

        approve(id)
        assertEquals(200, member.save(mapOf("status_window_enabled" to "false"), id, action = "submit").statusCode())
        // A public character's edit is a revision: only its creator gets it before approval.
        val off = characters.forChat(uuid, "ko-KR", adultAllowed = false, requesterId = UUID.fromString(member.memberId))
        assertNotNull(characters.forChat(uuid, "ko-KR", adultAllowed = false).statusWindow)
        assertEquals("*다가온다.*\n또 만났네.", off.firstMessage)
        assertEquals(null, off.statusWindow)
    }

    @Test
    fun `situation images are added, renamed and removed while the character is a draft`() {
        val member = Browser().login()
        val id = json(member.save(mapOf("name" to "겨울"))).get("id").asString()

        fun add(
            name: String?,
            bytes: ByteArray = picture(3000, 2000),
        ) = member.multipart("POST", "/characters/$id/images", listOfNotNull(name?.let { "name" to it }).toMap(), mapOf("file" to bytes))

        // CH-BE-32
        assertEquals(mapOf("name" to "required"), errors(add(null)))
        assertEquals(mapOf("name" to "too_long"), errors(add("가".repeat(41))))
        assertEquals(mapOf("file" to "invalid_image"), errors(add("gif", picture(10, 10, "gif"))))
        val first = json(add("눈길"))
        assertEquals(0, first.get("position").asInt())
        assertEquals("", first.get("description").asString())
        assertTrue(first.get("image_url").asString().contains("/characters/$id/images/"))
        assertEquals(mapOf("name" to "duplicate"), errors(add("눈길")))
        val second = json(add("골목"))
        assertEquals(1, second.get("position").asInt())

        // CH-BE-34
        val firstId = first.get("id").asString()
        val renamed =
            json(member.send("PATCH", "/characters/$id/images/$firstId", """{"description":"눈 오는 거리"}""".toByteArray(), "application/json"))
        assertEquals("눈길", renamed.get("name").asString())
        assertEquals("눈 오는 거리", renamed.get("description").asString())
        assertEquals(
            mapOf("name" to "duplicate"),
            errors(member.send("PATCH", "/characters/$id/images/$firstId", """{"name":"골목"}""".toByteArray(), "application/json")),
        )
        val long = """{"description":"${"가".repeat(201)}"}"""
        assertEquals(
            mapOf("description" to "too_long"),
            errors(member.send("PATCH", "/characters/$id/images/$firstId", long.toByteArray(), "application/json")),
        )
        assertEquals(
            listOf("눈길", "골목"),
            json(member.send("GET", "/characters/$id")).get("images").toList().map { it.get("name").asString() },
        )

        // CH-BE-20: another member touches nothing.
        val other = Browser().login()
        assertEquals(403 to "not_owner", code(other.send("GET", "/characters/$id")))
        assertEquals(403 to "not_owner", code(other.save(mapOf("name" to "x"), id)))
        assertEquals(
            403 to "not_owner",
            code(
                other.multipart(
                    "POST",
                    "/characters/$id/images",
                    mapOf("name" to "x"),
                    mapOf("file" to picture(8, 8)),
                ),
            ),
        )
        assertEquals(403 to "not_owner", code(other.send("DELETE", "/characters/$id")))

        assertEquals(204, member.send("DELETE", "/characters/$id/images/$firstId").statusCode())
        assertEquals(404 to "image_not_found", code(member.send("DELETE", "/characters/$id/images/$firstId")))
        assertEquals(1, json(member.send("GET", "/characters/$id")).get("images").size())

        // CH-BE-33: at the limit, and once submitted, nothing changes.
        val uuid = UUID.fromString(id)
        jdbc
            .sql(
                "INSERT INTO character_images (character_id, name, image_url, position) " +
                    "SELECT :id, 'n' || n, '/x', 100 + n FROM generate_series(1, 99) AS n",
            ).param("id", uuid)
            .update()
        assertEquals(409 to "image_limit_reached", code(add("하나 더", picture(8, 8))))
        jdbc.sql("DELETE FROM character_images WHERE character_id = :id AND name LIKE 'n%'").param("id", uuid).update()
        assertEquals(200, member.save(everything, id, action = "submit", thumbnail = picture(64, 64)).statusCode())
        val left = second.get("id").asString()
        assertEquals(409 to "save_not_allowed", code(add("심사 중", picture(8, 8))))
        assertEquals(409 to "save_not_allowed", code(member.send("DELETE", "/characters/$id/images/$left")))
        assertEquals(
            409 to "save_not_allowed",
            code(member.send("PATCH", "/characters/$id/images/$left", """{"name":"x"}""".toByteArray(), "application/json")),
        )
    }

    @Test
    fun `approval puts a character on the home page under its creator, who alone may chat before that`() {
        val creator = Browser().login()
        val id = creator.submitted()
        val uuid = UUID.fromString(id)
        val creatorId = UUID.fromString(creator.memberId)

        // CH-BE-08: a draft does not exist for chat; under review only the creator opens a room.
        val draft = json(creator.save(mapOf("name" to "초안"))).get("id").asString()
        assertFailsWith<com.dopia.character.CharacterNotFound> { characters.forChat(UUID.fromString(draft), "ko-KR", adultAllowed = false) }
        assertTrue(characters.forChat(uuid, "ko-KR", adultAllowed = false, requesterId = creatorId).canOpenNewRoom)
        assertFalse(characters.forChat(uuid, "ko-KR", adultAllowed = false, requesterId = UUID.randomUUID()).canOpenNewRoom)
        assertEquals(200, creator.send("POST", "/chats/open", """{"character_id":"$id"}""".toByteArray(), "application/json").statusCode())
        val visitor = Browser().login()
        assertEquals(404, visitor.send("POST", "/chats/open", """{"character_id":"$id"}""".toByteArray(), "application/json").statusCode())

        fun homeCard() =
            json(
                visitor.send("GET", "/home"),
            ).get("sections").flatMap { it.get("characters") }.firstOrNull { it.get("id").asString() == id }
        assertTrue(homeCard() == null)

        // CH-BE-22: the trigger stamps the approval and puts the character first in the last public section.
        approve(id)
        val card = assertNotNull(homeCard())
        assertEquals(creator.memberId, card.get("creator_id").asString())
        assertEquals(json(creator.send("GET", "/account/me")).get("nickname").asString(), card.get("creator_name").asString())
        assertNotNull(
            jdbc
                .sql("SELECT approved_at FROM characters WHERE id = :id")
                .param("id", uuid)
                .query(java.sql.Timestamp::class.java)
                .single(),
        )
        assertEquals(200, visitor.send("POST", "/chats/open", """{"character_id":"$id"}""".toByteArray(), "application/json").statusCode())

        // CH-BE-25: the creator profile lists public characters only.
        val profile = json(visitor.send("GET", "/creators/${creator.memberId}"))
        assertEquals(listOf(id), profile.get("characters").toList().map { it.get("id").asString() })
        assertEquals(404 to "creator_not_found", code(visitor.send("GET", "/creators/${UUID.randomUUID()}")))

        // CH-BE-09: the console cannot reject without a reason, or approve an incomplete character.
        assertFailsWith<DataIntegrityViolationException> {
            jdbc.sql("UPDATE characters SET status = 'rejected' WHERE id = :id").param("id", uuid).update()
        }
        assertFailsWith<DataIntegrityViolationException> {
            jdbc.sql("UPDATE characters SET status = 'approved' WHERE id = :id").param("id", UUID.fromString(draft)).update()
        }
        jdbc.sql("UPDATE characters SET status = 'rejected', rejection_reason = '이름 확인' WHERE id = :id").param("id", uuid).update()
        val rejected = json(creator.send("GET", "/characters/$id"))
        assertEquals("이름 확인", rejected.get("rejection_reason").asString())
        // A new submit clears the reason.
        assertTrue(json(creator.save(emptyMap(), id, action = "submit")).get("rejection_reason").isNull)

        // CH-BE-21: deleting takes it off every list; the room that exists still gets its settings.
        approve(id)
        assertEquals(204, creator.send("DELETE", "/characters/$id").statusCode())
        assertEquals(404 to "character_not_found", code(creator.send("DELETE", "/characters/$id")))
        assertTrue(homeCard() == null)
        assertFalse(characters.forChat(uuid, "ko-KR", adultAllowed = false, requesterId = creatorId).canOpenNewRoom)
    }

    @Test
    fun `a creator who withdraws takes their characters with them`() {
        // CH-BE-26
        val creator = Browser().login()
        val id = creator.submitted()
        approve(id)
        // An edit waiting for approval goes too, with its thumbnail.
        val edit = json(creator.save(mapOf("name" to "탈퇴 전 수정"), id, action = "submit", thumbnail = picture(8, 8)))
        val editImage = edit.get("image_url").asString()
        assertEquals(200, creator.send("POST", "/account/withdraw").statusCode())
        assertEquals(
            0,
            jdbc
                .sql("SELECT count(*) FROM character_revisions WHERE character_id = :id")
                .param("id", UUID.fromString(id))
                .query(Int::class.java)
                .single(),
        )
        assertEquals(
            404,
            HttpClient
                .newHttpClient()
                .send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port$editImage")).build(), HttpResponse.BodyHandlers.discarding())
                .statusCode(),
        )
        characters.clearCache()
        val deleted =
            jdbc
                .sql(
                    "SELECT deleted_at IS NOT NULL FROM characters WHERE id = :id",
                ).param("id", UUID.fromString(id))
                .query(Boolean::class.java)
                .single()
        assertTrue(deleted)
        assertEquals(404 to "creator_not_found", code(Browser().login().send("GET", "/creators/${creator.memberId}")))
    }

    @Test
    fun `the home banner is a picture with an optional link, the same for everyone`() {
        // CH-BE-01, CH-BE-03, CH-BE-09
        fun banner(browser: Browser): JsonNode {
            characters.clearCache()
            return json(browser.send("GET", "/home")).get("banner")
        }
        val guest = Browser()
        guest.send("POST", "/account/guest")
        val member = Browser().login()

        jdbc.sql("DELETE FROM home_banners").update()
        jdbc
            .sql(
                "INSERT INTO home_banners (image_url, link_url, is_public) VALUES ('/b/hidden.webp', 'https://example.com/a', false)",
            ).update()
        assertTrue(banner(guest).isNull)

        jdbc
            .sql(
                "INSERT INTO home_banners (image_url, link_url, created_at) VALUES " +
                    "('/b/old.webp', '/me', now() - interval '1 hour'), ('/b/new.webp', NULL, now())",
            ).update()
        listOf(guest, member).forEach {
            val shown = banner(it)
            assertEquals("/b/new.webp", shown.get("image_url").asString())
            assertTrue(shown.get("link_url").isNull)
            assertNotNull(UUID.fromString(shown.get("id").asString()))
        }
        // Taking the newest one down brings the one before it back, link and all.
        jdbc.sql("UPDATE home_banners SET is_public = false WHERE image_url = '/b/new.webp'").update()
        assertEquals("/me", banner(guest).get("link_url").asString())

        listOf("javascript:alert(1)", "//evil.example", "http://example.com", "me").forEach { link ->
            assertFailsWith<DataIntegrityViolationException>(link) {
                jdbc.sql("INSERT INTO home_banners (image_url, link_url) VALUES ('/b/x.webp', :link)").param("link", link).update()
            }
        }
    }

    @Test
    fun `an edit to a public character waits for approval while what is public stays`() {
        val creator = Browser().login()
        val id = creator.submitted()
        approve(id)
        val uuid = UUID.fromString(id)
        val creatorId = UUID.fromString(creator.memberId)
        val visitor = Browser().login()

        fun homeName(): String? {
            characters.clearCache()
            return json(visitor.send("GET", "/home"))
                .get("sections")
                .flatMap { it.get("characters") }
                .firstOrNull { it.get("id").asString() == id }
                ?.get("name")
                ?.asString()
        }

        fun detail() = json(creator.send("GET", "/characters/$id"))

        fun revisions() =
            jdbc
                .sql("SELECT count(*) FROM character_revisions WHERE character_id = :id")
                .param("id", uuid)
                .query(Int::class.java)
                .single()

        fun operator(
            call: String,
            reason: String? = null,
        ) {
            val statement = jdbc.sql("SELECT $call").param("id", uuid)
            (if (reason == null) statement else statement.param("reason", reason)).query { _, _ -> 1 }.list()
        }

        fun served(url: String) =
            HttpClient
                .newHttpClient()
                .send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port$url")).build(), HttpResponse.BodyHandlers.discarding())
                .statusCode()

        fun approvedAt() =
            jdbc
                .sql("SELECT approved_at FROM characters WHERE id = :id")
                .param("id", uuid)
                .query(java.sql.Timestamp::class.java)
                .single()

        val publicImage = detail().get("image_url").asString()
        val firstApproval = approvedAt()

        // CH-BE-36: a submit makes one revision and a second submit replaces it; the row is untouched.
        val first = json(creator.save(mapOf("name" to "새 제목"), id, action = "submit", thumbnail = picture(32, 32)))
        assertEquals("approved", first.get("status").asString())
        assertEquals("pending", first.get("revision_status").asString())
        assertEquals("새 제목", first.get("name").asString())
        val revisionImage = first.get("image_url").asString()
        assertTrue(revisionImage != publicImage)
        val second = json(creator.save(mapOf("tagline" to "새 소개"), id, action = "submit"))
        assertEquals("새 제목", second.get("name").asString())
        assertEquals("새 소개", second.get("tagline").asString())
        assertEquals(revisionImage, second.get("image_url").asString())
        assertEquals(1, revisions())
        assertEquals(200, served(publicImage))
        assertEquals(409 to "save_not_allowed", code(creator.save(mapOf("name" to "x"), id)))

        // CH-BE-37: everyone else keeps the public one; the creator gets the revision.
        assertEquals("눈 내리는 도시", homeName())
        val profile = json(visitor.send("GET", "/creators/${creator.memberId}")).get("characters").get(0)
        assertEquals("눈 내리는 도시", profile.get("name").asString())
        assertEquals("눈 내리는 도시", characters.forChat(uuid, "ko-KR", adultAllowed = false, requesterId = UUID.randomUUID()).name)
        assertEquals("새 제목", characters.forChat(uuid, "ko-KR", adultAllowed = false, requesterId = creatorId).name)
        val mine = json(creator.send("GET", "/characters/mine")).get("characters").first { it.get("id").asString() == id }
        assertEquals("새 제목", mine.get("name").asString())
        assertEquals("pending", mine.get("revision_status").asString())

        // CH-BE-41: it waits in the same queue as first submissions.
        val kind =
            jdbc
                .sql("SELECT kind FROM character_review_queue WHERE character_id = :id")
                .param("id", uuid)
                .query(String::class.java)
                .single()
        assertEquals("edit", kind)

        // CH-BE-39: a rejection touches the revision only, and a new submit puts it back in line.
        assertFailsWith<DataIntegrityViolationException> { operator("reject_character(:id, '')") }
        operator("reject_character(:id, :reason)", "제목 확인")
        assertEquals("approved", detail().get("status").asString())
        assertEquals("rejected", detail().get("revision_status").asString())
        assertEquals("제목 확인", detail().get("rejection_reason").asString())
        assertEquals("눈 내리는 도시", homeName())
        val again = json(creator.save(emptyMap(), id, action = "submit"))
        assertEquals("pending", again.get("revision_status").asString())
        assertTrue(again.get("rejection_reason").isNull)

        // CH-BE-38: approval puts the revision in the row and removes it; nothing else moves.
        operator("approve_character(:id)")
        assertEquals(0, revisions())
        assertEquals("새 제목", homeName())
        assertEquals("새 제목", characters.forChat(uuid, "ko-KR", adultAllowed = false, requesterId = UUID.randomUUID()).name)
        assertTrue(detail().get("revision_status").isNull)
        assertEquals("approved", detail().get("status").asString())
        assertEquals(revisionImage, detail().get("image_url").asString())
        assertEquals(firstApproval, approvedAt())
        assertFailsWith<org.springframework.dao.DataAccessException> { operator("approve_character(:id)") }

        // CH-BE-40: the creator can drop a revision; its own file goes, the public one stays.
        val dropped = json(creator.save(mapOf("name" to "또 고침"), id, action = "submit", thumbnail = picture(16, 16)))
        val droppedImage = dropped.get("image_url").asString()
        assertEquals(403 to "not_owner", code(visitor.send("DELETE", "/characters/$id/revision")))
        assertEquals(204, creator.send("DELETE", "/characters/$id/revision").statusCode())
        assertEquals(404, served(droppedImage))
        assertEquals(200, served(revisionImage))
        assertEquals("새 제목", detail().get("name").asString())
        assertEquals(404 to "revision_not_found", code(creator.send("DELETE", "/characters/$id/revision")))

        // Taking a public character down drops its revision; so does deleting it.
        creator.save(mapOf("name" to "내려가기 전"), id, action = "submit")
        assertEquals(1, revisions())
        jdbc.sql("UPDATE characters SET status = 'rejected', rejection_reason = '내림' WHERE id = :id").param("id", uuid).update()
        assertEquals(0, revisions())
        approve(id)
        val unapproved = json(creator.save(mapOf("name" to "지우기 전"), id, action = "submit", thumbnail = picture(8, 8)))
        val unapprovedImage = unapproved.get("image_url").asString()
        assertEquals(200, served(unapprovedImage))
        assertEquals(204, creator.send("DELETE", "/characters/$id").statusCode())
        assertEquals(0, revisions())
        // The edit's own thumbnail goes with it; the public one stays for rooms that exist.
        assertEquals(404, served(unapprovedImage))
        assertEquals(200, served(revisionImage))
    }

    @Test
    fun `every table is closed to roles other than this server`() {
        // A migration that adds a table must turn row level security on for it (V13).
        val open =
            jdbc
                .sql(
                    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
                        "WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity " +
                        "AND c.relname <> 'flyway_schema_history' ORDER BY 1",
                ).query(String::class.java)
                .list()
        assertEquals(emptyList(), open)
        val view =
            jdbc
                .sql("SELECT array_to_string(reloptions, ',') FROM pg_class WHERE relname = 'character_review_queue'")
                .query(String::class.java)
                .single()
        assertTrue(view.contains("security_invoker=true"))
    }
}
