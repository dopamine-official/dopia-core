import { type Page } from "@playwright/test";
import { expect, sent, test } from "./fixtures";

// TRACKING-PLAN 5: chat room events.
async function openChat(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "겨울 대화 시작", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "메시지", exact: true }),
  ).toBeEnabled();
  return page.url().split("/chats/")[1];
}
const input = (page: Page) =>
  page.getByRole("textbox", { name: "메시지", exact: true });

test("chat room view, sends, replies and buttons", async ({
  page,
  analytics,
}) => {
  const room = await openChat(page);
  const viewed = await sent(analytics, "chat_room_viewed", {
    room_id: room,
    load_result: "loaded",
    page: "chat_room",
  });
  const character = viewed.properties.character_id;
  expect(character).toBeTruthy();
  expect(viewed.properties).toMatchObject({
    is_member: false,
    adult_mode: false,
    locale: "ko-KR",
    environment: "dev",
  });

  await input(page).fill("안녕");
  await input(page).press("Enter");
  await sent(analytics, "message_send_clicked", {
    room_id: room,
    character_id: character,
    method: "enter",
    length: 2,
  });
  await sent(analytics, "message_reply_completed", {
    room_id: room,
    character_id: character,
    turn_index: 1,
  });

  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await input(page).fill("두 번째");
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await sent(analytics, "message_send_clicked", {
    method: "button",
    length: 4,
  });
  await sent(analytics, "message_reply_completed", { turn_index: 2 });

  await page
    .getByRole("button", { name: "행동 묘사 입력", exact: true })
    .click();
  await sent(analytics, "action_button_clicked", { room_id: room });

  // One view per room open, however often the room is read again.
  expect(
    analytics.filter((item) => item.event === "chat_room_viewed"),
  ).toHaveLength(1);
  // One outcome per send.
  expect(
    analytics.filter((item) => item.event === "message_reply_completed"),
  ).toHaveLength(2);
});

test("a failed reply is recorded once with its code", async ({
  page,
  analytics,
}) => {
  await page.goto("/preview");
  await page
    .getByRole("combobox", { name: "다음 답변", exact: true })
    .selectOption("fail");
  await expect(
    page.getByRole("status").filter({ hasText: "설정을 저장했어요." }),
  ).toBeVisible();
  const room = await openChat(page);
  await input(page).fill("실패할 메시지");
  await input(page).press("Enter");
  const failed = await sent(analytics, "message_reply_failed", {
    room_id: room,
  });
  expect(failed.properties.code).toEqual(expect.any(String));
  expect(failed.properties.code).not.toBe("");
  await page.waitForTimeout(2000);
  expect(
    analytics.filter((item) => item.event === "message_reply_failed"),
  ).toHaveLength(1);
  expect(
    analytics.filter((item) => item.event === "message_reply_completed"),
  ).toHaveLength(0);
});

test("a missing room redirects home and records why", async ({
  page,
  analytics,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
  await page.goto("/chats/00000000-0000-0000-0000-000000000000");
  await expect(page).toHaveURL("/");
  await sent(analytics, "chat_room_redirected", {
    room_id: "00000000-0000-0000-0000-000000000000",
    page: "chat_room",
  });
  expect(
    analytics.filter((item) => item.event === "chat_room_viewed"),
  ).toHaveLength(0);
});
