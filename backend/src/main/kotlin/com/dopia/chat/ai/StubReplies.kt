package com.dopia.chat.ai

import java.util.UUID

/** Reply texts of the dev sample characters (frontend/src/mocks/characters.ts). */
object StubReplies {
    private val fallback =
        mapOf(
            "ko-KR" to listOf("*잠시 생각에 잠긴다.*\n그 얘기, 조금 더 들려줄래요?"),
            "zh-TW" to listOf("*她想了一下。*\n可以再多說一點嗎？"),
            "en-US" to listOf("*She pauses to think.*\nTell me a little more about that."),
        )

    private val replies: Map<UUID, Map<String, List<String>>> =
        mapOf(
            UUID.fromString("7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d") to
                mapOf(
                    "ko-KR" to
                        listOf(
                            "*찻잔을 내려놓으며 희미하게 웃는다.*\n마침 잘 오셨어요. 오늘은 무슨 이야기를 들려주실 건가요?",
                            "*창가의 빈 의자를 가리킨다.*\n서두르지 않아도 괜찮아요. 차가 식기 전까지, 여기서 잠깐 쉬세요.",
                            "*책갈피를 끼우고 당신을 바라본다.*\n흠, 조금은 흥미롭네요. 그다음은요?",
                        ),
                    "zh-TW" to
                        listOf(
                            "*她放下茶杯，露出淡淡的笑容。*\n你來得正好。今天想和我說些什麼呢？",
                            "*她指向窗邊的空椅子。*\n不必急。在茶涼之前，先在這裡休息一下吧。",
                            "*她夾好書籤，抬眼看向你。*\n嗯，有點意思。然後呢？",
                        ),
                    "en-US" to
                        listOf(
                            "*She sets down a teacup with a faint smile.*\nGood timing. What story will you tell me today?",
                            "*She gestures to the chair by the window.*\nThere is no rush. Sit here a while, before your tea gets cold.",
                            "*She slips a bookmark into her book and looks at you.*\nHmm, that is rather interesting. What happened next?",
                        ),
                ),
            UUID.fromString("3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d") to
                mapOf(
                    "ko-KR" to
                        listOf(
                            "*옆으로 한 발 비켜 자리를 내준다.*\n그냥 같이 걷자. 나도 딱히 급한 일은 없으니까.",
                            "*잠시 하늘을 올려다본다.*\n오늘 공기 좋다. 너랑 있으면 이런 것도 눈에 들어오네.",
                        ),
                    "zh-TW" to
                        listOf(
                            "*她往旁邊挪了一步，留出位置。*\n一起走吧，反正我也不趕時間。",
                            "*她抬頭望了一下天空。*\n今天的空氣真好。和你在一起，連這些都注意到了。",
                        ),
                    "en-US" to
                        listOf(
                            "*She steps aside to make room for you.*\nLet us walk together. I am not in a hurry.",
                            "*She glances up at the sky.*\nNice air today. I notice things like that when you are around.",
                        ),
                ),
            UUID.fromString("db5b1830-d826-4b1a-b67a-3bf7899a87f2") to
                mapOf(
                    "ko-KR" to
                        listOf(
                            "*책 한 권을 조심스럽게 꺼낸다.*\n이건 어때요? 첫 장부터 천천히 읽어봐요.",
                            "*책상 위 작은 조명을 켠다.*\n여기는 조금 늦게까지 열어둬요. 편하게 머물러요.",
                        ),
                    "zh-TW" to
                        listOf(
                            "*他小心地抽出一本書。*\n這本怎麼樣？我們從第一頁慢慢讀。",
                            "*他打開桌上的小燈。*\n這裡會開晚一點，安心坐坐吧。",
                        ),
                    "en-US" to
                        listOf(
                            "*He carefully pulls a book from the shelf.*\nHow about this one? Let us take it one page at a time.",
                            "*He switches on a little desk lamp.*\nWe stay open late. Make yourself at home.",
                        ),
                ),
            UUID.fromString("82c115c4-41f6-4773-bdb9-048dd404af9c") to
                mapOf(
                    "ko-KR" to
                        listOf(
                            "*음악 소리를 조금 줄인다.*\n여기서는 편하게 이야기해도 괜찮아요. 듣고 있을게요.",
                            "*창밖의 불빛을 바라보다 미소 짓는다.*\n이 시간의 도시는 참 다르죠. 조금 더 있다 갈래요?",
                        ),
                    "zh-TW" to
                        listOf(
                            "*他把音樂調小聲了些。*\n在這裡可以放心說話，我會聽著。",
                            "*他看向窗外的燈光，微微一笑。*\n這個時間的城市很不一樣呢。要再待一會兒嗎？",
                        ),
                    "en-US" to
                        listOf(
                            "*He turns the music down a little.*\nYou can speak freely here. I am listening.",
                            "*He smiles at the lights outside the window.*\nThe city feels different at this hour. Stay a little longer?",
                        ),
                ),
        )

    fun of(
        characterId: UUID,
        locale: String,
    ): List<String> {
        val byLocale = replies[characterId] ?: fallback
        return byLocale[locale] ?: byLocale.values.first()
    }
}
