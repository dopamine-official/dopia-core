import { type Captured, expect, sent, settle, test } from "./fixtures";

// TRACKING-PLAN 7-1, 7-2: the 404 screen. Its header is covered in analytics-home.spec.ts.

const count = (events: Captured[], event: string) =>
  events.filter((item) => item.event === event).length;

test("404 view and its home button", async ({ page, analytics }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  await sent(analytics, "not_found_viewed", { page: "not_found" });

  await page.getByRole("link", { name: "홈으로", exact: true }).click();
  await expect(page).toHaveURL("/");
  await sent(analytics, "home_button_clicked", { page: "not_found" });
  await settle(page);
  // Once, though React's dev mode mounts the screen twice.
  expect(count(analytics, "not_found_viewed")).toBe(1);
  expect(count(analytics, "home_button_clicked")).toBe(1);
});
