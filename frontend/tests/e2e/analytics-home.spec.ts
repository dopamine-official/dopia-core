import { type Page } from "@playwright/test";
import { type Captured, expect, sent, test } from "./fixtures";

// TRACKING-PLAN 3: home screen events and the shared header, sidebar and footer.
async function home(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
}
const count = (events: Captured[], event: string) =>
  events.filter((item) => item.event === event).length;
const winter = (page: Page) =>
  page.getByRole("button", { name: "겨울 대화 시작", exact: true });
const more = (page: Page) =>
  page.getByRole("button", { name: "겨울 대화 설정", exact: true });
const menuButton = (page: Page) =>
  page.getByRole("button", { name: "대화 목록 열기 또는 닫기", exact: true });
/** Shows the recent list: narrow screens keep it behind the menu button. */
async function showRecent(page: Page) {
  if (!(await more(page).isVisible())) await menuButton(page).click();
  await expect(more(page)).toBeVisible();
}
/**
 * Makes every read of an API path fail with 503 until `restoreReads`. The app retries a
 * failed read once by itself, so a failure screen needs more than one failure.
 */
async function failReads(page: Page, path: string) {
  await page.addInitScript((path) => {
    const flags = window as unknown as { e2eFail: boolean };
    flags.e2eFail = true;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (flags.e2eFail && new URL(url, location.href).pathname === path)
        return Promise.resolve(
          new Response(JSON.stringify({ code: "e2e_down" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        );
      return original(input, init);
    };
  }, path);
}
async function restoreReads(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { e2eFail: boolean }).e2eFail = false;
  });
}
async function startChat(page: Page) {
  await home(page);
  await winter(page).click();
  await expect(page).toHaveURL(/\/chats\//);
  return page.url().split("/chats/")[1];
}

test("home view, card views and a card click", async ({ page, analytics }) => {
  await home(page);
  await sent(analytics, "home_viewed", { load_result: "loaded", page: "home" });
  // Cards count as seen only once half of one is on screen.
  await winter(page).scrollIntoViewIfNeeded();
  const viewed = await sent(analytics, "character_card_viewed", {
    position: 1,
  });
  expect(viewed.properties.section_id).toEqual(expect.any(String));
  expect(viewed.properties.character_id).toEqual(expect.any(String));

  await winter(page).click();
  const clicked = await sent(analytics, "character_card_clicked", {
    page: "home",
  });
  expect(clicked.properties.position).toEqual(expect.any(Number));
  await expect(page).toHaveURL(/\/chats\//);
  await sent(analytics, "chat_room_viewed", {
    character_id: clicked.properties.character_id,
  });

  // A card is counted once per home view.
  const ids = analytics
    .filter((item) => item.event === "character_card_viewed")
    .map(
      (item) => `${item.properties.section_id}:${item.properties.character_id}`,
    );
  expect(new Set(ids).size).toBe(ids.length);
  expect(count(analytics, "home_viewed")).toBe(1);
});

test("banner click", async ({ page, analytics }) => {
  await home(page);
  await page.locator("button.hero").click();
  const banner = await sent(analytics, "banner_clicked", { page: "home" });
  expect(banner.properties.character_id).toEqual(expect.any(String));
  await expect(page).toHaveURL(/\/chats\//);
});

test("a failed home read and its retry", async ({ page, analytics }) => {
  await failReads(page, "/api/v1/home");
  await page.goto("/");
  await sent(analytics, "home_viewed", { load_result: "failed" });
  await restoreReads(page);
  await page
    .getByRole("main")
    .getByRole("button", { name: "다시 불러오기", exact: true })
    .click();
  await sent(analytics, "retry_clicked", { target: "home_list", page: "home" });
  await sent(analytics, "retry_finished", {
    target: "home_list",
    result: "loaded",
  });
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
  expect(count(analytics, "home_viewed")).toBe(1);
});

test("a failed recent list and its retry", async ({
  page,
  analytics,
  isMobile,
}) => {
  await failReads(page, "/api/v1/chats/recent");
  await home(page);
  await sent(analytics, "recent_chats_load_failed", { page: "home" });
  // Narrow screens: the drawer reads the list again on opening, and fails again.
  if (isMobile) await menuButton(page).click();
  const retry = page
    .getByRole(isMobile ? "dialog" : "complementary")
    .getByRole("button", { name: "다시 불러오기", exact: true });
  await expect(retry).toBeVisible();
  await restoreReads(page);
  await retry.click();
  await sent(analytics, "retry_clicked", { target: "recent_chats" });
  await sent(analytics, "retry_finished", {
    target: "recent_chats",
    result: "loaded",
  });
  // The sidebar and the drawer share one read: one failure, one event.
  expect(count(analytics, "recent_chats_load_failed")).toBe(1);
});

test("header, footer and SAFE toggle", async ({ page, analytics }) => {
  test.setTimeout(90_000);
  await home(page);

  await page
    .getByRole("combobox", { name: "언어", exact: true })
    .selectOption("en-US");
  await sent(analytics, "locale_changed", { from: "ko-KR", to: "en-US" });
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("ko-KR");
  await sent(analytics, "locale_changed", { from: "en-US", to: "ko-KR" });

  await page.getByRole("button", { name: "고객센터", exact: true }).click();
  await sent(analytics, "footer_link_clicked", {
    item: "customer_support",
    page: "home",
  });
  await page.keyboard.press("Escape");
  await sent(analytics, "footer_modal_closed", { item: "customer_support" });

  const safe = page.getByRole("switch", { name: "세이프 모드", exact: true });
  await safe.click();
  await sent(analytics, "safe_toggle_clicked", { to: "safe_off" });
  await sent(analytics, "safe_toggle_finished", {
    to: "safe_off",
    result: "login_required",
  });
  const login = page.getByRole("dialog", { name: "이야기를 이어가세요" });
  await login.getByRole("button", { name: "닫기", exact: true }).click();

  await page
    .locator(".site_header")
    .getByRole("button", { name: "로그인", exact: true })
    .click();
  await sent(analytics, "login_link_clicked", { page: "home" });
  await login
    .getByRole("button", { name: "Google로 로그인", exact: true })
    .click();
  const profile = page.getByRole("button", { name: "내 프로필", exact: true });
  await expect(profile).toBeVisible();

  await safe.click();
  await sent(analytics, "safe_toggle_finished", {
    to: "safe_off",
    result: "verification_required",
    is_member: true,
  });

  await profile.click();
  await sent(analytics, "profile_button_clicked", { open: true });
  await page.keyboard.press("Escape");
  await sent(analytics, "profile_menu_closed", { method: "escape" });
  await profile.click();
  await page.locator("h1").first().click({ force: true });
  await sent(analytics, "profile_menu_closed", { method: "outside" });
  await profile.click();
  await profile.click();
  await sent(analytics, "profile_button_clicked", { open: false });
  await profile.click();
  await page.getByRole("button", { name: "충전", exact: true }).click();
  await sent(analytics, "profile_menu_item_clicked", { item: "charge" });

  await page.goto("/me");
  await page.getByRole("link", { name: "캐릭터챗", exact: true }).click();
  await sent(analytics, "logo_clicked", { page: "me" });
});

test("sidebar toggles", async ({ page, analytics, isMobile }) => {
  await home(page);
  await menuButton(page).click();
  await sent(analytics, "sidebar_toggled", {
    open: isMobile,
    page: "home",
  });
  await page.keyboard.press("ControlOrMeta+b");
  await sent(analytics, "sidebar_toggled", { open: !isMobile });
  expect(count(analytics, "sidebar_toggled")).toBe(2);
});

test("recent chats: open, menu and delete", async ({ page, analytics }) => {
  const room = await startChat(page);
  await home(page);
  await showRecent(page);

  await more(page).click();
  const opened = await sent(analytics, "recent_chat_more_clicked", {
    room_id: room,
    open: true,
  });
  expect(opened.properties.character_id).toEqual(expect.any(String));
  await page.keyboard.press("Escape");
  await sent(analytics, "recent_chat_menu_closed", {
    room_id: room,
    method: "escape",
  });

  await more(page).click();
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  await sent(analytics, "chat_delete_clicked", { room_id: room });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "취소", exact: true })
    .click();
  await sent(analytics, "chat_delete_cancelled", {
    room_id: room,
    method: "cancel",
  });

  await showRecent(page);
  await page.getByRole("link", { name: "겨울", exact: true }).click();
  await sent(analytics, "recent_chat_clicked", {
    room_id: room,
    position: 1,
    page: "home",
  });
  await expect(page).toHaveURL(`/chats/${room}`);

  // Deleting the room on screen, from the chat room's own sidebar.
  await menuButton(page).click();
  await sent(analytics, "sidebar_toggled", { open: true, page: "chat_room" });
  await more(page).click();
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "대화 삭제", exact: true })
    .click();
  await sent(analytics, "chat_delete_confirmed", { room_id: room });
  await sent(analytics, "chat_deleted", {
    room_id: room,
    is_current_room: true,
    page: "chat_room",
  });
  await expect(page).toHaveURL("/");
  expect(count(analytics, "chat_delete_cancelled")).toBe(1);
});
