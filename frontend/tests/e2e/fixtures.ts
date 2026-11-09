import { test as base, expect, type Page } from "@playwright/test";
import { gunzipSync } from "node:zlib";

export type Captured = { event: string; properties: Record<string, unknown> };

// Every test runs with analytics on (playwright.config.ts). PostHog requests are answered
// here so nothing leaves the browser, and the events are kept for tests that check them.
export const test = base.extend<{
  analytics: Captured[];
  autoConsent: boolean;
  consent: void;
}>({
  autoConsent: [true, { option: true }],
  // The terms modal opens over every first visit (ACCOUNT web 2-2-6). Tests about other
  // screens agree through it whenever it is in the way; tests/e2e/compliance.spec.ts covers it.
  consent: [
    async ({ context, autoConsent }, use) => {
      if (!autoConsent) return use();
      const agree = (page: Page) =>
        page.addLocatorHandler(
          page.locator("dialog.consent_modal"),
          async (dialog) => {
            await dialog.getByRole("checkbox", { name: "전체 동의" }).check();
            await dialog
              .getByRole("button", { name: "동의하고 시작하기" })
              .click();
          },
        );
      await Promise.all(context.pages().map(agree));
      context.on("page", (page) => void agree(page));
      await use();
    },
    { auto: true },
  ],
  analytics: [
    async ({ context }, use) => {
      const events: Captured[] = [];
      await context.route("**/ingest/**", async (route) => {
        const body = route.request().postDataBuffer();
        if (body) {
          let text: string;
          try {
            text = gunzipSync(body).toString();
          } catch {
            text = body.toString();
          }
          try {
            const data = JSON.parse(text) as { batch?: Captured[] } | Captured;
            events.push(
              ...("batch" in data && data.batch
                ? data.batch
                : [data as Captured]),
            );
          } catch {
            // Not an event payload.
          }
        }
        await route.fulfill({ status: 200, body: "{}" });
      });
      await use(events);
    },
    { auto: true },
  ],
});
export { expect };

/**
 * Waits past a few PostHog batches (sent every 250 ms in e2e, playwright.config.ts), so a
 * late duplicate is counted before a test checks how many were sent.
 */
export const settle = (page: Page) => page.waitForTimeout(1_000);

/** Waits until an event with these properties was sent, and returns it. */
export async function sent(
  events: Captured[],
  event: string,
  properties: Record<string, unknown> = {},
) {
  const match = () =>
    events.find(
      (item) =>
        item.event === event &&
        Object.entries(properties).every(
          ([key, value]) => item.properties[key] === value,
        ),
    );
  await expect.poll(() => match(), { timeout: 15_000 }).toBeTruthy();
  return match()!;
}
