import { type Page } from "@playwright/test";
import { type Captured, expect, sent, settle, signIn, test } from "./fixtures";
import { installStubs, setStubs } from "./stubs";

// TRACKING-PLAN 6: My Page events. Logout and withdrawal success are server events.

const count = (events: Captured[], event: string) =>
  events.filter((item) => item.event === event).length;
const dialog = (page: Page) => page.getByRole("dialog");
const editButton = (page: Page) =>
  page.getByRole("button", { name: "프로필 수정", exact: true });
const save = (page: Page) =>
  dialog(page).getByRole("button", { name: "저장", exact: true });
const photo = (page: Page) => page.getByLabel("프로필 사진", { exact: true });
// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Logs in on home and opens My Page from the profile menu. */
async function profile(page: Page) {
  await page.goto("/");
  await page
    .locator(".site_header")
    .getByRole("button", { name: "로그인", exact: true })
    .click();
  await dialog(page)
    .getByRole("button", { name: "Google로 로그인", exact: true })
    .click();
  await page.getByRole("button", { name: "내 프로필", exact: true }).click();
  await page
    .getByRole("navigation", { name: "내 메뉴", exact: true })
    .getByRole("link")
    .first()
    .click();
  await expect(editButton(page)).toBeVisible();
}

test("My Page view, and the shared parts record page me", async ({
  page,
  analytics,
}) => {
  await page.goto("/me");
  await expect(dialog(page)).toBeVisible();
  await settle(page);
  // A guest goes on to the login modal: not a view.
  expect(count(analytics, "me_viewed")).toBe(0);

  await profile(page);
  await sent(analytics, "me_viewed", { page: "me", is_member: true });
  await page.getByRole("button", { name: "고객센터", exact: true }).click();
  await sent(analytics, "footer_link_clicked", { page: "me" });
  await page.keyboard.press("Escape");
  await page.locator(".site_header").getByRole("link").first().click();
  await expect(page).toHaveURL("/");
  await sent(analytics, "logo_clicked", { page: "me" });
  await settle(page);
  expect(count(analytics, "me_viewed")).toBe(1);
});

test("profile edit: photo checks, saves, failures and closing", async ({
  page,
  analytics,
}) => {
  test.setTimeout(90_000);
  await profile(page);
  await editButton(page).click();
  await sent(analytics, "profile_edit_clicked", { page: "me" });

  await photo(page).setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await sent(analytics, "profile_photo_selected", { result: "invalid_type" });
  await photo(page).setInputFiles({
    name: "big.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
  });
  await sent(analytics, "profile_photo_selected", { result: "too_large" });

  // Nothing changed: the server refuses it.
  await save(page).click();
  await sent(analytics, "profile_save_clicked", { page: "me" });
  await sent(analytics, "profile_update_failed", { code: "invalid_input" });

  await photo(page).setInputFiles({
    name: "face.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await sent(analytics, "profile_photo_selected", { result: "accepted" });
  await page.getByLabel("닉네임", { exact: true }).fill("기록 확인");
  await save(page).click();
  await sent(analytics, "profile_updated", { changed: "both" });
  await expect(dialog(page)).toHaveCount(0);

  await editButton(page).click();
  await page.getByLabel("닉네임", { exact: true }).fill("기록 확인 둘");
  await save(page).click();
  await sent(analytics, "profile_updated", { changed: "nickname" });

  await editButton(page).click();
  await photo(page).setInputFiles({
    name: "face.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await save(page).click();
  await sent(analytics, "profile_updated", { changed: "photo" });

  await editButton(page).click();
  await dialog(page).getByRole("button", { name: "취소", exact: true }).click();
  await sent(analytics, "profile_edit_closed", { method: "cancel" });
  await editButton(page).click();
  await dialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await sent(analytics, "profile_edit_closed", { method: "close" });
  await editButton(page).click();
  await page.keyboard.press("Escape");
  await sent(analytics, "profile_edit_closed", { method: "escape" });
  await editButton(page).click();
  await page.mouse.click(4, 4);
  await expect(dialog(page)).toHaveCount(0);
  await sent(analytics, "profile_edit_closed", { method: "outside" });

  await settle(page);
  // A save closes the modal without counting as closed.
  expect(count(analytics, "profile_edit_closed")).toBe(4);
  expect(count(analytics, "profile_save_clicked")).toBe(4);
  expect(count(analytics, "profile_updated")).toBe(3);
});

test("logout and withdrawal: clicks, cancels and failures", async ({
  page,
  analytics,
}) => {
  await installStubs(page);
  await profile(page);
  await setStubs(page, [
    { path: "/api/v1/account/logout", status: 503 },
    { path: "/api/v1/account/withdraw", status: 503 },
  ]);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await sent(analytics, "logout_clicked", { page: "me" });
  await sent(analytics, "logout_failed", { code: "e2e_down" });

  const withdraw = page.getByRole("button", { name: "회원 탈퇴", exact: true });
  await withdraw.click();
  await sent(analytics, "withdraw_clicked", { page: "me" });
  await dialog(page).getByRole("button", { name: "취소", exact: true }).click();
  await sent(analytics, "withdraw_cancelled", { method: "cancel" });
  await withdraw.click();
  await dialog(page).getByRole("button", { name: "닫기", exact: true }).click();
  await withdraw.click();
  await page.keyboard.press("Escape");
  await sent(analytics, "withdraw_cancelled", { method: "escape" });
  await withdraw.click();
  await page.mouse.click(4, 4);
  await expect(dialog(page)).toHaveCount(0);
  await sent(analytics, "withdraw_cancelled", { method: "outside" });

  await withdraw.click();
  await dialog(page)
    .getByRole("button", { name: "회원 탈퇴", exact: true })
    .click();
  await sent(analytics, "withdraw_confirmed", { page: "me" });
  await sent(analytics, "withdraw_failed", { code: "e2e_down" });
  await settle(page);
  // The close button counts as cancel.
  expect(count(analytics, "withdraw_cancelled")).toBe(4);
  expect(count(analytics, "withdraw_clicked")).toBe(5);
});

test("closing the edit modal while it saves is not a close", async ({
  page,
  analytics,
}) => {
  await installStubs(page);
  await profile(page);
  await setStubs(page, [
    { path: "/api/v1/account/me", method: "PATCH", delay: 1500 },
  ]);
  await editButton(page).click();
  await page.getByLabel("닉네임", { exact: true }).fill("저장 중 닫기");
  await save(page).click();
  await page.keyboard.press("Escape");
  await sent(analytics, "profile_updated", { changed: "nickname" });
  await settle(page);
  expect(count(analytics, "profile_edit_closed")).toBe(0);
});

test("a successful logout still sends its click", async ({
  page,
  analytics,
}) => {
  await profile(page);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page).toHaveURL("/");
  // Sent as the member, though PostHog starts over right after.
  const clicked = await sent(analytics, "logout_clicked", { page: "me" });
  expect(clicked.properties.is_member).toBe(true);
});

test("the profile menu logs out from any screen, in red", async ({
  page,
  analytics,
}) => {
  await page.goto("/");
  await signIn(page);
  await page.getByRole("button", { name: "내 프로필", exact: true }).click();
  const logout = page
    .getByRole("navigation", { name: "내 메뉴", exact: true })
    .getByRole("button", { name: "로그아웃", exact: true });
  await expect(logout).toHaveCSS("color", "rgb(224, 114, 114)");
  await logout.click();
  await expect(logout).toBeHidden();
  await sent(analytics, "profile_menu_item_clicked", { item: "logout" });
  await sent(analytics, "logout_clicked", { page: "home" });
  await expect(
    page
      .locator(".site_header")
      .getByRole("button", { name: "로그인", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL("/");
});
