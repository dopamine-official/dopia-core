import { type Page } from "@playwright/test";
import { type Captured, expect, sent, test } from "./fixtures";
import { installStubs, setStubs } from "./stubs";

// TRACKING-PLAN 3: home screen events and the shared header, sidebar and footer.

async function home(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
}
/** posthog-js sends in batches: wait past one flush so a late duplicate is counted. */
const settle = (page: Page) => page.waitForTimeout(4_000);
const count = (events: Captured[], event: string) =>
  events.filter((item) => item.event === event).length;
const card = (page: Page, name: string) =>
  page.getByRole("button", { name: `${name} 대화 시작`, exact: true });
const more = (page: Page, name = "겨울") =>
  page.getByRole("button", { name: `${name} 대화 설정`, exact: true });
const menuButton = (page: Page) =>
  page.getByRole("button", { name: "대화 목록 열기 또는 닫기", exact: true });
const dialog = (page: Page) => page.getByRole("dialog");
/** Shows the recent list: narrow screens keep it behind the menu button. */
async function showRecent(page: Page) {
  if (!(await more(page).isVisible())) await menuButton(page).click();
  await expect(more(page)).toBeVisible();
}
async function startChat(page: Page, name = "겨울") {
  await home(page);
  await card(page, name).click();
  await expect(page).toHaveURL(/\/chats\//);
  return page.url().split("/chats/")[1];
}
async function login(page: Page) {
  await page
    .locator(".site_header")
    .getByRole("button", { name: "로그인", exact: true })
    .click();
  await dialog(page)
    .getByRole("button", { name: "Google로 로그인", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "내 프로필", exact: true }),
  ).toBeVisible();
}
/** Clicks the backdrop of the open modal, outside its box. */
const clickOutside = (page: Page) => page.mouse.click(4, 4);

test("home view, card views and a card click", async ({
  page,
  analytics,
  isMobile,
}) => {
  await home(page);
  await sent(analytics, "home_viewed", { load_result: "loaded", page: "home" });
  if (!isMobile) {
    // On a desktop screen the first cards show less than half at the bottom edge.
    await settle(page);
    expect(count(analytics, "character_card_viewed")).toBe(0);
  }
  await card(page, "겨울").scrollIntoViewIfNeeded();
  await card(page, "겨울").click();
  const clicked = await sent(analytics, "character_card_clicked", {
    page: "home",
  });
  const viewed = await sent(analytics, "character_card_viewed", {
    character_id: clicked.properties.character_id,
  });
  expect(viewed.properties).toMatchObject({
    section_id: clicked.properties.section_id,
    position: clicked.properties.position,
    page: "home",
  });
  await expect(page).toHaveURL(/\/chats\//);
  await sent(analytics, "chat_room_viewed", {
    character_id: clicked.properties.character_id,
  });

  await settle(page);
  // A card is counted once per home view.
  const ids = analytics
    .filter((item) => item.event === "character_card_viewed")
    .map(
      (item) => `${item.properties.section_id}:${item.properties.character_id}`,
    );
  expect(new Set(ids).size).toBe(ids.length);
  expect(count(analytics, "home_viewed")).toBe(1);
  expect(count(analytics, "character_card_clicked")).toBe(1);
});

test("banner click", async ({ page, analytics }) => {
  await home(page);
  await page.locator("button.hero").click();
  const banner = await sent(analytics, "banner_clicked", { page: "home" });
  expect(banner.properties.character_id).toEqual(expect.any(String));
  await expect(page).toHaveURL(/\/chats\//);
});

test("a chat that fails to open", async ({ page, analytics }) => {
  await installStubs(page, [
    { path: "/api/v1/chats/open", method: "POST", status: 503 },
  ]);
  await home(page);
  await card(page, "겨울").click();
  const clicked = await sent(analytics, "character_card_clicked");
  await sent(analytics, "chat_open_failed", {
    source: "card",
    character_id: clicked.properties.character_id,
    code: "e2e_down",
    page: "home",
  });
  await page.locator("button.hero").click();
  await sent(analytics, "chat_open_failed", {
    source: "banner",
    code: "e2e_down",
  });
  await expect(page).toHaveURL("/");
  await settle(page);
  expect(count(analytics, "chat_open_failed")).toBe(2);
});

test("a failed home read and its retry", async ({ page, analytics }) => {
  // The app retries a failed read once by itself, so this fails every read until removed.
  await installStubs(page, [{ path: "/api/v1/home", status: 503 }]);
  await page.goto("/");
  await sent(analytics, "home_viewed", { load_result: "failed" });
  await setStubs(page, []);
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
  await settle(page);
  expect(count(analytics, "home_viewed")).toBe(1);
  expect(count(analytics, "retry_clicked")).toBe(1);
});

test("a failed recent list is recorded when shown, on each screen", async ({
  page,
  analytics,
  isMobile,
}) => {
  await installStubs(page, [{ path: "/api/v1/chats/recent", status: 503 }]);
  await home(page);
  if (isMobile) {
    // The list sits in the closed drawer: nothing is on screen yet.
    await settle(page);
    expect(count(analytics, "recent_chats_load_failed")).toBe(0);
    await menuButton(page).click();
  }
  await sent(analytics, "recent_chats_load_failed", { page: "home" });
  const retry = page
    .getByRole(isMobile ? "dialog" : "complementary")
    .getByRole("button", { name: "다시 불러오기", exact: true });
  await retry.click();
  await sent(analytics, "retry_finished", {
    target: "recent_chats",
    result: "failed",
  });
  await settle(page);
  // A retry that fails again leaves the same notice up: no second failure.
  expect(count(analytics, "recent_chats_load_failed")).toBe(1);
  if (isMobile) {
    await dialog(page).getByRole("button", { name: "닫기" }).click();
    // Opening the drawer again shows the same failure: still one.
    await menuButton(page).click();
    await expect(
      dialog(page).getByRole("button", { name: "다시 불러오기", exact: true }),
    ).toBeVisible();
    await settle(page);
    expect(count(analytics, "recent_chats_load_failed")).toBe(1);
    await dialog(page).getByRole("button", { name: "닫기" }).click();
  }

  // Another screen showing the failure records it with its own page.
  await card(page, "겨울").click();
  await expect(page).toHaveURL(/\/chats\//);
  await menuButton(page).click();
  await sent(analytics, "recent_chats_load_failed", { page: "chat_room" });

  await setStubs(page, []);
  await dialog(page)
    .getByRole("button", { name: "다시 불러오기", exact: true })
    .click();
  await sent(analytics, "retry_clicked", {
    target: "recent_chats",
    page: "chat_room",
  });
  await sent(analytics, "retry_finished", {
    target: "recent_chats",
    result: "loaded",
  });
  await settle(page);
  expect(count(analytics, "recent_chats_load_failed")).toBe(2);
});

test("header, footer, profile menu and 404", async ({ page, analytics }) => {
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

  const support = page.getByRole("button", { name: "고객센터", exact: true });
  await support.click();
  await sent(analytics, "footer_link_clicked", {
    item: "customer_support",
    page: "home",
  });
  await page.keyboard.press("Escape");
  await support.click();
  await dialog(page).getByRole("button", { name: "정책 닫기" }).click();
  await support.click();
  await clickOutside(page);
  await expect(dialog(page)).toHaveCount(0);
  await settle(page);
  expect(count(analytics, "footer_link_clicked")).toBe(3);
  expect(count(analytics, "footer_modal_closed")).toBe(3);

  const safe = page.getByRole("switch", { name: "세이프 모드", exact: true });
  await safe.click();
  await sent(analytics, "safe_toggle_clicked", { to: "safe_off" });
  await sent(analytics, "safe_toggle_finished", {
    to: "safe_off",
    result: "login_required",
  });
  await dialog(page).getByRole("button", { name: "닫기", exact: true }).click();

  await login(page);
  await sent(analytics, "login_link_clicked", { page: "home" });
  await safe.click();
  await sent(analytics, "safe_toggle_finished", {
    to: "safe_off",
    result: "verification_required",
    is_member: true,
  });

  const profile = page.getByRole("button", { name: "내 프로필", exact: true });
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
  await dialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await profile.click();
  await page.locator(".menu_profile").click();
  await sent(analytics, "profile_menu_item_clicked", { item: "profile" });
  await expect(page).toHaveURL("/me");
  await settle(page);
  // Only the two closes without choosing an item.
  expect(count(analytics, "profile_menu_closed")).toBe(2);

  await page.getByRole("link", { name: "캐릭터챗", exact: true }).click();
  await sent(analytics, "logo_clicked", { page: "me" });

  await page.goto("/no-such-page");
  await page.getByRole("link", { name: "캐릭터챗", exact: true }).click();
  await sent(analytics, "logo_clicked", { page: "not_found" });
});

test("SAFE toggle applied and failed for a verified member", async ({
  page,
  analytics,
}) => {
  // The mock has no adult verification: mark the member verified on the way in.
  await installStubs(page, [
    { path: "/api/v1/mock/login", merge: { adult_verified: true } },
    { path: "/api/v1/account/me", merge: { adult_verified: true } },
    {
      path: "/api/v1/account/me/adult_mode",
      method: "PATCH",
      account: { adult_verified: true, adult_mode: true },
    },
  ]);
  await home(page);
  await login(page);
  const safe = page.getByRole("switch", { name: "세이프 모드", exact: true });
  await safe.click();
  // Sent before the account changes: it still carries the mode it was sent from.
  await sent(analytics, "safe_toggle_finished", {
    to: "safe_off",
    result: "applied",
    adult_mode: false,
  });
  await expect(safe).not.toBeChecked();

  await setStubs(page, [
    { path: "/api/v1/account/me/adult_mode", method: "PATCH", status: 503 },
  ]);
  await safe.click();
  await sent(analytics, "safe_toggle_clicked", {
    to: "safe_on",
    adult_mode: true,
  });
  await sent(analytics, "safe_toggle_finished", {
    to: "safe_on",
    result: "failed",
  });
});

test("sidebar toggles", async ({ page, analytics, isMobile }) => {
  await home(page);
  await menuButton(page).click();
  await sent(analytics, "sidebar_toggled", { open: isMobile, page: "home" });
  await page.keyboard.press("ControlOrMeta+b");
  await sent(analytics, "sidebar_toggled", { open: !isMobile });
  await settle(page);
  expect(count(analytics, "sidebar_toggled")).toBe(2);
});

test("recent chats: menu, delete outcomes and the room on screen", async ({
  page,
  analytics,
  isMobile,
}) => {
  test.setTimeout(120_000);
  await installStubs(page);
  const room = await startChat(page);
  await home(page);
  await showRecent(page);
  const ids = { room_id: room };

  await more(page).click();
  const opened = await sent(analytics, "recent_chat_more_clicked", {
    ...ids,
    open: true,
  });
  expect(opened.properties.character_id).toEqual(expect.any(String));
  await page.keyboard.press("Escape");
  await sent(analytics, "recent_chat_menu_closed", {
    ...ids,
    method: "escape",
  });

  // Esc still closes the menu after focus has left it, and only the menu.
  await more(page).click();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  if (isMobile) await expect(dialog(page)).toBeVisible();

  await more(page).click();
  // The list's own heading: outside the menu, inside the sidebar or drawer.
  await (isMobile ? dialog(page) : page.getByRole("complementary"))
    .locator("h2")
    .click();
  await sent(analytics, "recent_chat_menu_closed", {
    ...ids,
    method: "outside",
  });

  const del = async () => {
    await showRecent(page);
    await more(page).click();
    await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
  };
  await del();
  await sent(analytics, "chat_delete_clicked", ids);
  await dialog(page).getByRole("button", { name: "취소", exact: true }).click();
  await del();
  await page.keyboard.press("Escape");
  await del();
  await clickOutside(page);
  await expect(dialog(page)).toHaveCount(0);
  for (const method of ["cancel", "escape", "outside"])
    await sent(analytics, "chat_delete_cancelled", { ...ids, method });

  await setStubs(page, [
    { path: `/api/v1/chats/${room}`, method: "DELETE", status: 503 },
  ]);
  await del();
  await dialog(page)
    .getByRole("button", { name: "대화 삭제", exact: true })
    .click();
  await sent(analytics, "chat_delete_failed", { ...ids, code: "e2e_down" });
  await setStubs(page, []);

  await showRecent(page);
  await page.getByRole("link", { name: "겨울", exact: true }).click();
  await sent(analytics, "recent_chat_clicked", {
    ...ids,
    position: 1,
    page: "home",
  });
  await expect(page).toHaveURL(`/chats/${room}`);

  // Deleting the room on screen, from the chat room's own sidebar. Esc while the delete
  // is on its way does not count as a cancel.
  await menuButton(page).click();
  await sent(analytics, "sidebar_toggled", { open: true, page: "chat_room" });
  await setStubs(page, [
    { path: `/api/v1/chats/${room}`, method: "DELETE", delay: 1_500 },
  ]);
  await more(page).click();
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  await dialog(page)
    .getByRole("button", { name: "대화 삭제", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await sent(analytics, "chat_delete_confirmed", ids);
  await sent(analytics, "chat_deleted", {
    ...ids,
    is_current_room: true,
    page: "chat_room",
  });
  await expect(page).toHaveURL("/");
  await settle(page);
  expect(count(analytics, "chat_delete_cancelled")).toBe(3);
  expect(count(analytics, "recent_chat_menu_closed")).toBe(3);
  expect(count(analytics, "chat_deleted")).toBe(1);
});

test("recent chat clicks from the chat room and My Page", async ({
  page,
  analytics,
}) => {
  await startChat(page, "겨울");
  const second = await startChat(page, "골목 서점의 유진");
  await menuButton(page).click();
  await page.getByRole("link", { name: "겨울", exact: true }).click();
  const fromRoom = await sent(analytics, "recent_chat_clicked", {
    page: "chat_room",
  });
  expect(fromRoom.properties.position).toBe(2);

  await home(page);
  await login(page);
  await page.goto("/me");
  await page
    .locator(".profile_recent")
    .getByRole("link", { name: "골목 서점의 유진", exact: true })
    .click();
  await sent(analytics, "recent_chat_clicked", {
    room_id: second,
    page: "me",
  });
});

test("app error screen and its retry", async ({ page, analytics }) => {
  const crash = (on: boolean) =>
    page.evaluate((value) => {
      (window as unknown as { e2eCrash: boolean }).e2eCrash = value;
    }, on);
  await page.addInitScript(() => {
    (window as unknown as { e2eCrash: boolean }).e2eCrash = true;
  });
  await page.goto("/e2e/crash");
  const retry = page.getByRole("button", {
    name: "다시 불러오기",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await sent(analytics, "error_screen_viewed", {
    target: "app",
    code: "unknown",
    page: "error",
  });

  await retry.click();
  await sent(analytics, "retry_clicked", { target: "app", page: "error" });
  await sent(analytics, "retry_finished", { target: "app", result: "failed" });
  await expect(retry).toBeVisible();

  await crash(false);
  await retry.click();
  await expect(page.locator("main#main")).toHaveText("recovered");
  await sent(analytics, "retry_finished", { target: "app", result: "loaded" });
  await settle(page);
  expect(count(analytics, "retry_clicked")).toBe(2);
  expect(count(analytics, "retry_finished")).toBe(2);
  // Shown first, then again after the retry that failed.
  expect(count(analytics, "error_screen_viewed")).toBe(2);
});

test("app error screen retry when the same error is thrown again", async ({
  page,
  analytics,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { e2eCrash: string }).e2eCrash = "same";
  });
  await page.goto("/e2e/crash");
  const retry = page.getByRole("button", {
    name: "다시 불러오기",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await sent(analytics, "error_screen_viewed", { target: "app" });

  await retry.click();
  await sent(analytics, "retry_finished", { target: "app", result: "failed" });
  // The button still works after a retry that failed the same way.
  await page.evaluate(() => {
    (window as unknown as { e2eCrash: boolean }).e2eCrash = false;
  });
  await retry.click();
  await expect(page.locator("main#main")).toHaveText("recovered");
  await sent(analytics, "retry_finished", { target: "app", result: "loaded" });
  await settle(page);
  expect(count(analytics, "retry_clicked")).toBe(2);
  expect(count(analytics, "retry_finished")).toBe(2);
  expect(count(analytics, "error_screen_viewed")).toBe(2);
});
