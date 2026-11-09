import { type Page } from "@playwright/test";
import { type Captured, expect, sent, settle, test } from "./fixtures";

// TRACKING-PLAN 4: login modal events. e2e logs in through the mock API, which answers at
// once; the provider round trip is played by the note the modal leaves before leaving
// (src/lib/login.ts) and the URL the server returns to.

async function home(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "오리지널", exact: true }),
  ).toBeVisible();
}
const count = (events: Captured[], event: string) =>
  events.filter((item) => item.event === event).length;
const dialog = (page: Page) => page.getByRole("dialog");
const headerLogin = (page: Page) =>
  page
    .locator(".site_header")
    .getByRole("button", { name: "로그인", exact: true });
const google = (page: Page) =>
  dialog(page).getByRole("button", { name: "Google로 로그인", exact: true });
/** Leaves the note the modal writes before going to the provider. */
const leaveNote = (
  page: Page,
  note: { provider: string; trigger: string; page?: string; at?: number },
) =>
  page.evaluate((value) => {
    sessionStorage.setItem(
      "dopia:login",
      JSON.stringify({ at: Date.now(), ...value }),
    );
  }, note);

test("login button: shown, closed three ways, then a login", async ({
  page,
  analytics,
}) => {
  await home(page);
  await headerLogin(page).click();
  await sent(analytics, "login_modal_viewed", {
    trigger: "login_button",
    page: "home",
  });
  await page.keyboard.press("Escape");
  await sent(analytics, "login_modal_closed", {
    trigger: "login_button",
    method: "escape",
  });
  await headerLogin(page).click();
  await dialog(page).getByRole("button", { name: "닫기" }).click();
  await sent(analytics, "login_modal_closed", { method: "button" });
  await headerLogin(page).click();
  await page.mouse.click(4, 4);
  await expect(dialog(page)).toHaveCount(0);
  await sent(analytics, "login_modal_closed", { method: "outside" });

  await headerLogin(page).click();
  await google(page).click();
  await sent(analytics, "login_provider_clicked", {
    provider: "google",
    trigger: "login_button",
    page: "home",
  });
  const succeeded = await sent(analytics, "login_succeeded", {
    provider: "google",
    trigger: "login_button",
  });
  // Recorded as the member the guest just became.
  expect(succeeded.properties.is_member).toBe(true);
  await settle(page);
  expect(count(analytics, "login_modal_viewed")).toBe(4);
  expect(count(analytics, "login_modal_closed")).toBe(3);
});

test("SAFE toggle and the chat room open the modal with their trigger", async ({
  page,
  analytics,
}) => {
  await home(page);
  await page.getByRole("switch", { name: "세이프 모드", exact: true }).click();
  await sent(analytics, "login_modal_viewed", {
    trigger: "safe_toggle",
    page: "home",
  });
  await page.keyboard.press("Escape");
  await sent(analytics, "login_modal_closed", { trigger: "safe_toggle" });

  await page
    .getByRole("button", { name: "겨울 대화 시작", exact: true })
    .click();
  await expect(page).toHaveURL(/\/chats\//);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await sent(analytics, "login_modal_viewed", {
    trigger: "login_button",
    page: "chat_room",
  });
});

test("a guest on a members-only screen", async ({ page, analytics }) => {
  await page.goto("/me");
  await expect(google(page)).toBeVisible();
  await sent(analytics, "login_modal_viewed", { trigger: "members_only" });
  await settle(page);
  expect(count(analytics, "login_modal_viewed")).toBe(1);
});

test("coming back from the provider: failed, cancelled, succeeded", async ({
  page,
  analytics,
}) => {
  await home(page);
  await leaveNote(page, {
    provider: "apple",
    trigger: "safe_toggle",
    page: "chat_room",
  });
  await page.goto("/?login=1&error=login_failed");
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  await sent(analytics, "login_modal_viewed", {
    trigger: "login_failed",
    page: "home",
  });
  // On the screen the modal was opened from, not the one it reopened on.
  await sent(analytics, "login_failed", {
    provider: "apple",
    trigger: "safe_toggle",
    page: "chat_room",
  });

  // Cancelled from My Page: the server returns there, which sends a guest on to home.
  await leaveNote(page, { provider: "google", trigger: "members_only" });
  await page.goto("/me?login=1");
  await expect(google(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await sent(analytics, "login_modal_viewed", {
    trigger: "login_cancelled",
    page: "home",
  });

  // A note from long ago is not a round trip that just ended.
  await leaveNote(page, {
    provider: "google",
    trigger: "login_button",
    at: Date.now() - 60 * 60_000,
  });
  await page.goto("/?login=1");
  await expect(google(page)).toBeVisible();
  await sent(analytics, "login_modal_viewed", { trigger: "members_only" });

  await google(page).click();
  await sent(analytics, "login_succeeded", { trigger: "members_only" });
  await leaveNote(page, { provider: "apple", trigger: "login_button" });
  await page.goto("/");
  await sent(analytics, "login_succeeded", {
    provider: "apple",
    trigger: "login_button",
    page: "home",
  });
  await settle(page);
  expect(count(analytics, "login_failed")).toBe(1);
  expect(
    analytics.filter(
      (item) =>
        item.event === "login_modal_viewed" &&
        item.properties.trigger === "login_cancelled",
    ),
  ).toHaveLength(1);
  expect(count(analytics, "login_succeeded")).toBe(2);
});

test("back from the provider page without finishing", async ({ page }) => {
  await home(page);
  await page
    .locator(".site_header")
    .getByRole("button", { name: "로그인", exact: true })
    .click();
  await expect(google(page)).toBeEnabled();
  await leaveNote(page, { provider: "google", trigger: "login_button" });
  // The browser restoring this page from its back-forward cache.
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("dopia:login")),
  ).toBeNull();
  await expect(google(page)).toBeEnabled();
});

test("a login that returns to My Page is recorded before the screen's view", async ({
  page,
  analytics,
}) => {
  await home(page);
  await headerLogin(page).click();
  await google(page).click();
  await expect(
    page.getByRole("button", { name: "내 프로필", exact: true }),
  ).toBeVisible();
  // Opened on home for My Page; the provider returns to My Page.
  await leaveNote(page, {
    provider: "apple",
    trigger: "members_only",
    page: "home",
  });
  await page.goto("/me");
  await sent(analytics, "login_succeeded", { provider: "apple", page: "home" });
  await sent(analytics, "me_viewed");
  const order = analytics.map((item) => item.event);
  const succeeded = order.findLastIndex((event) => event === "login_succeeded");
  expect(succeeded).toBeLessThan(order.lastIndexOf("me_viewed"));
});
