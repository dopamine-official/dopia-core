import { type Page } from "@playwright/test";
import { test, expect, signIn } from "./fixtures";
import { installStubs, setStubs } from "./stubs";

// The smallest valid PNG; the mock checks only the type and size of a picture.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const picture = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: png,
});

async function member(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
  await signIn(page);
}
const step = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "제작 단계" }).getByRole("button", {
    name: new RegExp(name),
  });
const line = (page: Page) => page.locator(".ce_status");

/** Fills everything a submit needs except the thumbnail. */
async function fill(page: Page) {
  await step(page, "캐릭터 정보").click();
  await page.locator("#ce_name").fill("눈 내리는 도시");
  await page.locator("#ce_tagline").fill("늦었네.");
  await page.locator("#ce_character_name").fill("겨울");
  await page.getByRole("radio", { name: "여성" }).check();
  await page.locator("#ce_age").fill("24살");
  await expect(page.locator("#ce_age")).toHaveValue("24");
  await step(page, "프롬프트").click();
  await page.locator("#ce_personality").fill("차갑다");
  await page.locator("#ce_speech_style").fill("반말");
  await page.locator("#ce_world_setting").fill("눈의 도시");
  await step(page, "시작 상황").click();
  await page.locator("#ce_first_message").fill("*돌아선다.* 늦었네.");
}

test("a member makes a character, adds images, submits, chats with it and deletes it", async ({
  page,
}) => {
  await member(page);
  await page.goto("/characters/new");
  await expect(step(page, "캐릭터 정보")).toHaveAttribute(
    "aria-current",
    "step",
  );

  // A draft saves with gaps, and the address follows the new character.
  await page.locator("#ce_name").fill("눈 내리는 도시");
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/[\da-f-]{36}\/edit$/);
  await expect(line(page)).toContainText("저장됨");

  // A submit with gaps goes to the first one and sends nothing.
  await step(page, "등록").click();
  await page.getByRole("button", { name: "제출", exact: true }).click();
  await expect(step(page, "캐릭터 정보")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(line(page)).toContainText("비어 있는 칸이 있어요");
  await expect(page.locator("#ce_thumbnail")).toBeFocused();

  await page
    .locator(".ce_slot input[type=file]")
    .setInputFiles(picture("thumb.png"));
  await expect(page.locator("#ce_thumbnail img")).toBeVisible();
  await fill(page);

  // The status window: values only, shown under the first message in the preview.
  await step(page, "프롬프트").click();
  await page.getByRole("tab", { name: "상태창" }).click();
  await page.getByRole("checkbox", { name: "상태창 사용" }).check();
  await page.locator("#ce_status_window_format").fill("호감도: <0~100>");
  await page.locator("#ce_status_window_initial").fill("호감도: 5");

  // Situation images: a name is English letters, digits, _ and -; two files with one name
  // get different names, and a file named in another script gets a plain one.
  await step(page, "미디어 관리").click();
  await page
    .locator(".ce_pane > input[type=file]")
    .setInputFiles([
      picture("snow.png"),
      picture("snow.png"),
      picture("눈길.png"),
      { ...picture("메모.txt"), mimeType: "text/plain" },
    ]);
  await expect(page.locator(".ce_item")).toHaveCount(3);
  await expect(line(page)).toContainText("3장 추가");
  await expect(line(page)).toContainText("메모.txt (형식)");
  const names = page.getByRole("textbox", { name: "이미지 이름" });
  const descriptions = page.getByRole("textbox", { name: "상황 설명" });
  await expect(names.nth(0)).toHaveValue("snow");
  await expect(names.nth(1)).toHaveValue("snow-2");
  await expect(names.nth(2)).toHaveValue("image");
  await page.getByRole("button", { name: "삭제", exact: true }).last().click();
  await expect(page.locator(".ce_item")).toHaveCount(2);
  await names.nth(1).fill("snow");
  await expect(page.getByText("같은 이름의 이미지가 있어요.")).toHaveCount(2);
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(line(page)).toContainText("같은 이름의 이미지가 있어요.");
  // A space becomes _, and anything else that is not allowed is not typed at all.
  await names.nth(1).fill("창가 by window!");
  await expect(names.nth(1)).toHaveValue("_by_window");
  await names.nth(1).fill("window");
  await names.nth(1).blur();
  await expect(line(page)).not.toContainText("저장됨");
  // A description is optional: one picture is saved with it and the other without.
  await descriptions.nth(0).fill("눈 오는 거리를 걸을 때");
  await expect(page.locator(".ce_item .ce_error")).toHaveCount(0);
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(line(page)).toContainText("저장됨");
  await page.reload();
  await step(page, "미디어 관리").click();
  await expect(names.nth(1)).toHaveValue("window");
  await page.getByRole("button", { name: "삭제", exact: true }).first().click();
  await expect(page.locator(".ce_item")).toHaveCount(1);

  await step(page, "등록").click();
  await page.getByRole("button", { name: "제출", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/mine$/);
  const item = page.locator(".mine_item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("눈 내리는 도시");
  await expect(item).toContainText("심사 중");

  // Under review it can still be edited: the draft save and the pictures stay open.
  await item.getByRole("link", { name: "수정", exact: true }).click();
  await expect(page.locator("#ce_name")).toHaveValue("눈 내리는 도시");
  await expect(
    page.getByRole("button", { name: "임시 저장", exact: true }),
  ).toHaveCount(1);
  // A save keeps it under review, and it stays complete: an emptied name is refused.
  await page.locator("#ce_name").fill("");
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(line(page)).toContainText("저장하지 못했어요");
  await page.locator("#ce_name").fill("눈 내리는 도시");
  await step(page, "미디어 관리").click();
  const reviewNames = page.getByRole("textbox", { name: "이미지 이름" });
  await expect(reviewNames).toHaveCount(1);
  await reviewNames.first().fill("window_night");
  await page.getByRole("button", { name: "임시 저장", exact: true }).click();
  await expect(line(page)).toContainText("저장됨");
  await page.reload();
  await step(page, "미디어 관리").click();
  await expect(reviewNames.first()).toHaveValue("window_night");
  await page.goto("/characters/mine");
  await expect(page.locator(".mine_item")).toContainText("심사 중");

  // The creator chats with it before any review; the first status values are in the room.
  await page.goto("/characters/mine");
  await page
    .locator(".mine_item")
    .getByRole("button", { name: "대화하기", exact: true })
    .click();
  await expect(page).toHaveURL(/\/chats\/[\da-f-]{36}$/);
  await expect(page.locator(".message.assistant").first()).toContainText(
    "늦었네.",
  );
  // A reply that names a picture shows it above its text, outside the bubble.
  await page.getByRole("textbox", { name: "메시지", exact: true }).fill("안녕");
  await page.keyboard.press("Enter");
  const reply = page.locator(".message_wrap.assistant").last().locator("> *");
  await expect(reply.nth(0)).toHaveAttribute("alt", "window_night");
  await expect(reply.nth(1)).toHaveText("고개를 끄덕인다. 계속 말해 봐.");
  await expect(page.locator(".message_list")).not.toContainText("{{");

  await page.goto("/characters/mine");
  await page
    .locator(".mine_item")
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "캐릭터 삭제" })
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  await expect(page.locator(".mine_item")).toHaveCount(0);
  await expect(page.getByText("아직 만든 캐릭터가 없어요.")).toBeVisible();
});

test("the creation screens are for members with creation on", async ({
  page,
}) => {
  // A guest is sent to the login modal over home.
  await page.goto("/characters/new");
  await expect(
    page.getByRole("dialog", { name: "이야기를 이어가세요" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  await page.keyboard.press("Escape");
  await signIn(page);
  await page.getByRole("button", { name: "내 프로필", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "내 캐릭터 목록", exact: true }),
  ).toBeVisible();
});

test("a member without creation on sees no entry and is sent home", async ({
  page,
}) => {
  await installStubs(page, [
    {
      path: "/api/v1/account/me",
      merge: { character_creation_enabled: false },
    },
    // The preview's login answers with the account itself.
    {
      path: "/api/v1/mock/login",
      merge: { character_creation_enabled: false },
    },
  ]);
  await member(page);
  await page.getByRole("button", { name: "내 프로필", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "내 캐릭터 목록", exact: true }),
  ).toHaveCount(0);
  await page.goto("/characters/mine");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("a public character is edited through a revision", async ({ page }) => {
  await installStubs(page);
  await member(page);
  await page.goto("/characters/new");
  await page
    .locator(".ce_slot input[type=file]")
    .setInputFiles(picture("thumb.png"));
  await fill(page);
  await step(page, "등록").click();
  await page.getByRole("button", { name: "제출", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/mine$/);
  const href = await page
    .locator(".mine_item")
    .getByRole("link", { name: "수정", exact: true })
    .getAttribute("href");
  const id = href!.split("/")[2];

  // The preview never approves, so the answers say the character is public.
  await setStubs(page, [
    {
      path: `/api/v1/characters/${id}`,
      method: "GET",
      merge: {
        status: "approved",
        revision_status: "rejected",
        rejection_reason: "제목을 확인해 주세요.",
      },
    },
  ]);
  await page
    .locator(".mine_item")
    .getByRole("link", { name: "수정", exact: true })
    .click();
  await expect(
    page.getByText("승인 전까지는 지금 공개된 내용이 그대로 보입니다"),
  ).toBeVisible();
  await expect(page.getByText("제목을 확인해 주세요.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "임시 저장", exact: true }),
  ).toHaveCount(0);

  // The submit button turns on only after a change, and off again when it is undone.
  await step(page, "등록").click();
  const submit = page.getByRole("button", { name: "제출", exact: true });
  await expect(submit).toBeDisabled();
  await step(page, "캐릭터 정보").click();
  await page.locator("#ce_name").fill("새 제목");
  await step(page, "등록").click();
  await expect(submit).toBeEnabled();
  await step(page, "캐릭터 정보").click();
  await page.locator("#ce_name").fill("눈 내리는 도시");
  await step(page, "등록").click();
  await expect(submit).toBeDisabled();

  // The list shows both badges and the reason of a rejected edit.
  await setStubs(page, [
    {
      path: "/api/v1/characters/mine",
      merge: {
        characters: [
          {
            id,
            name: "새 제목",
            image_url: null,
            status: "approved",
            revision_status: "rejected",
            rejection_reason: "제목을 확인해 주세요.",
            updated_at: "2026-11-15T00:00:00Z",
          },
        ],
      },
    },
  ]);
  // Inside the app: a page load would put the first stubs back.
  await page.getByRole("link", { name: "캐릭터챗", exact: true }).click();
  await page.getByRole("button", { name: "내 프로필", exact: true }).click();
  await page.getByRole("link", { name: "내 캐릭터 목록", exact: true }).click();
  const item = page.locator(".mine_item");
  await expect(item).toContainText("공개");
  await expect(item).toContainText("수정 반려");
  await expect(item).toContainText("제목을 확인해 주세요.");
});

test("the situation images of a public character are changed through a revision", async ({
  page,
}) => {
  await installStubs(page);
  await member(page);
  await page.goto("/characters/new");
  await page
    .locator(".ce_slot input[type=file]")
    .setInputFiles(picture("thumb.png"));
  await fill(page);
  await step(page, "등록").click();
  await page.getByRole("button", { name: "제출", exact: true }).click();
  await expect(page).toHaveURL(/\/characters\/mine$/);
  const edit = page
    .locator(".mine_item")
    .getByRole("link", { name: "수정", exact: true });
  const id = (await edit.getAttribute("href"))!.split("/")[2];

  // The preview never approves, so the answers say the character is public.
  await setStubs(page, [
    {
      path: `/api/v1/characters/${id}`,
      method: "GET",
      merge: { status: "approved" },
    },
  ]);
  await edit.click();
  const submit = page.getByRole("button", { name: "제출", exact: true });
  await step(page, "등록").click();
  await expect(submit).toBeDisabled();

  // The images are open, with a line saying when others see the change.
  await step(page, "미디어 관리").click();
  await expect(
    page.getByText("바꾼 이미지는 제출해서 승인된 뒤에 다른 사람에게 보여요."),
  ).toBeVisible();
  await page
    .locator(".ce_pane > input[type=file]")
    .setInputFiles(picture("snow.png"));
  await expect(page.locator(".ce_item")).toHaveCount(1);

  // An added image alone is something to submit.
  await step(page, "등록").click();
  await expect(submit).toBeEnabled();

  // Removing it again leaves nothing to submit.
  await step(page, "미디어 관리").click();
  await page.getByRole("button", { name: "삭제", exact: true }).last().click();
  await expect(page.locator(".ce_item")).toHaveCount(0);
  await step(page, "등록").click();
  await expect(submit).toBeDisabled();

  // The list says when a change is not submitted yet.
  await setStubs(page, [
    {
      path: "/api/v1/characters/mine",
      merge: {
        characters: [
          {
            id,
            name: "눈 내리는 도시",
            image_url: null,
            status: "approved",
            revision_status: "draft",
            rejection_reason: null,
            updated_at: "2026-11-15T00:00:00Z",
          },
        ],
      },
    },
  ]);
  await page.getByRole("link", { name: "캐릭터챗", exact: true }).click();
  await page.getByRole("button", { name: "내 프로필", exact: true }).click();
  await page.getByRole("link", { name: "내 캐릭터 목록", exact: true }).click();
  const item = page.locator(".mine_item");
  await expect(item).toContainText("공개");
  await expect(item).toContainText("수정 제출 전");
});
