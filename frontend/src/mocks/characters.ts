import type { Locale } from "@/i18n";
type Content = {
  name: string;
  tagline: string;
  first_message: string;
  replies: string[];
};
export type Character = {
  id: string;
  image_url: string;
  creator_name: string;
  is_adult: boolean;
  texts: Record<Locale, Content>;
};
export const characters: Character[] = [
  {
    id: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
    image_url: "/images/main_banner.png",
    creator_name: "Studio Chat",
    is_adult: false,
    texts: {
      "ko-KR": {
        name: "나를 경멸하는 메이드님!",
        tagline: "차는 따뜻하게, 말투는 차갑게. 저택의 오후가 시작됩니다.",
        first_message:
          "*그녀가 고개를 들고, 읽던 책을 덮는다.*\n오늘은 꽤 일찍 오셨네요. 차라도 드릴까요?",
        replies: [
          "*찻잔을 내려놓으며 희미하게 웃는다.*\n마침 잘 오셨어요. 오늘은 무슨 이야기를 들려주실 건가요?",
          "*창가의 빈 의자를 가리킨다.*\n서두르지 않아도 괜찮아요. 차가 식기 전까지, 여기서 잠깐 쉬세요.",
          "*책갈피를 끼우고 당신을 바라본다.*\n흠, 조금은 흥미롭네요. 그다음은요?",
        ],
      },
      "zh-TW": {
        name: "鄙視我的女僕小姐！",
        tagline: "茶是溫的，語氣卻很冷。宅邸的午後就此展開。",
        first_message:
          "*她抬起頭，合上手中的書。*\n今天來得真早呢。要喝杯茶嗎？",
        replies: [
          "*她放下茶杯，露出淡淡的笑容。*\n你來得正好。今天想和我說些什麼呢？",
          "*她指向窗邊的空椅子。*\n不必急。在茶涼之前，先在這裡休息一下吧。",
          "*她夾好書籤，抬眼看向你。*\n嗯，有點意思。然後呢？",
        ],
      },
      "en-US": {
        name: "The unimpressed maid",
        tagline: "Warm tea, cool words. An afternoon at the manor begins.",
        first_message:
          "*She looks up and closes her book.*\nYou are early today. Shall I make some tea?",
        replies: [
          "*She sets down a teacup with a faint smile.*\nGood timing. What story will you tell me today?",
          "*She gestures to the chair by the window.*\nThere is no rush. Sit here a while, before your tea gets cold.",
          "*She slips a bookmark into her book and looks at you.*\nHmm, that is rather interesting. What happened next?",
        ],
      },
    },
  },
  {
    id: "3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d",
    image_url: "/images/mock_gray.svg",
    creator_name: "Studio Chat",
    is_adult: false,
    texts: {
      "ko-KR": {
        name: "겨울",
        tagline: "내가 귀찮게 구는 게 아니라, 네가 쓸데없이 편한 거야.",
        first_message:
          "*주머니에 손을 넣은 채 다가온다.*\n또 만났네. 오늘은 어디 가는 길이야?",
        replies: [
          "*옆으로 한 발 비켜 자리를 내준다.*\n그냥 같이 걷자. 나도 딱히 급한 일은 없으니까.",
          "*잠시 하늘을 올려다본다.*\n오늘 공기 좋다. 너랑 있으면 이런 것도 눈에 들어오네.",
        ],
      },
      "zh-TW": {
        name: "冬",
        tagline: "才不是想黏著你，只是跟你在一起太自在了。",
        first_message:
          "*她把手插在口袋裡，慢慢走近。*\n又見面了。今天要去哪裡？",
        replies: [
          "*她往旁邊挪了一步，留出位置。*\n一起走吧，反正我也不趕時間。",
          "*她抬頭望了一下天空。*\n今天的空氣真好。和你在一起，連這些都注意到了。",
        ],
      },
      "en-US": {
        name: "Winter",
        tagline:
          "I am not following you. You are just unusually easy to be around.",
        first_message:
          "*She approaches with her hands in her pockets.*\nYou again. Where are you heading today?",
        replies: [
          "*She steps aside to make room for you.*\nLet us walk together. I am not in a hurry.",
          "*She glances up at the sky.*\nNice air today. I notice things like that when you are around.",
        ],
      },
    },
  },
  {
    id: "db5b1830-d826-4b1a-b67a-3bf7899a87f2",
    image_url: "/images/mock_gray.svg",
    creator_name: "Studio Chat",
    is_adult: false,
    texts: {
      "ko-KR": {
        name: "골목 서점의 유진",
        tagline: "타이베이의 작은 서점. 당신을 위한 책 한 권을 골라둘게요.",
        first_message:
          "*서가 사이로 고개를 내민다.*\n어서 오세요. 오늘은 어떤 이야기가 끌리세요?",
        replies: [
          "*책 한 권을 조심스럽게 꺼낸다.*\n이건 어때요? 첫 장부터 천천히 읽어봐요.",
          "*책상 위 작은 조명을 켠다.*\n여기는 조금 늦게까지 열어둬요. 편하게 머물러요.",
        ],
      },
      "zh-TW": {
        name: "巷口書店的宇辰",
        tagline: "台北的一間小書店，為你留了一本書。",
        first_message: "*他從書架間探出頭。*\n歡迎光臨。今天想讀什麼樣的故事？",
        replies: [
          "*他小心地抽出一本書。*\n這本怎麼樣？我們從第一頁慢慢讀。",
          "*他打開桌上的小燈。*\n這裡會開晚一點，安心坐坐吧。",
        ],
      },
      "en-US": {
        name: "Eugene at the bookshop",
        tagline:
          "A small bookshop in Taipei, with a book set aside just for you.",
        first_message:
          "*He peeks out from between the shelves.*\nWelcome. What kind of story are you in the mood for?",
        replies: [
          "*He carefully pulls a book from the shelf.*\nHow about this one? Let us take it one page at a time.",
          "*He switches on a little desk lamp.*\nWe stay open late. Make yourself at home.",
        ],
      },
    },
  },
  {
    id: "82c115c4-41f6-4773-bdb9-048dd404af9c",
    image_url: "/images/mock_gray.svg",
    creator_name: "Studio Chat",
    is_adult: true,
    texts: {
      "ko-KR": {
        name: "밤의 라운지, 레이",
        tagline: "늦은 밤의 재즈와, 아직 끝나지 않은 이야기.",
        first_message:
          "*조용한 라운지에서 손을 흔든다.*\n기다리고 있었어요. 오늘 하루는 어땠어요?",
        replies: [
          "*음악 소리를 조금 줄인다.*\n여기서는 편하게 이야기해도 괜찮아요. 듣고 있을게요.",
          "*창밖의 불빛을 바라보다 미소 짓는다.*\n이 시간의 도시는 참 다르죠. 조금 더 있다 갈래요?",
        ],
      },
      "zh-TW": {
        name: "深夜酒廊的雷",
        tagline: "深夜的爵士樂，與還沒說完的故事。",
        first_message:
          "*他在安靜的酒廊裡揮了揮手。*\n我在等你。今天過得怎麼樣？",
        replies: [
          "*他把音樂調小聲了些。*\n在這裡可以放心說話，我會聽著。",
          "*他看向窗外的燈光，微微一笑。*\n這個時間的城市很不一樣呢。要再待一會兒嗎？",
        ],
      },
      "en-US": {
        name: "Ray at the night lounge",
        tagline: "Late-night jazz and a story that is not over yet.",
        first_message:
          "*He waves from the quiet lounge.*\nI was waiting for you. How was your day?",
        replies: [
          "*He turns the music down a little.*\nYou can speak freely here. I am listening.",
          "*He smiles at the lights outside the window.*\nThe city feels different at this hour. Stay a little longer?",
        ],
      },
    },
  },
];
export function getCharacter(id: string) {
  return characters.find((character) => character.id === id);
}
export function characterInfo(character: Character, locale: Locale) {
  return {
    id: character.id,
    name: character.texts[locale].name,
    image_url: character.image_url,
  };
}
