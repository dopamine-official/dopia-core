import { test as base, expect, type Page } from "@playwright/test";
import { gunzipSync } from "node:zlib";

export type Captured = { event: string; properties: Record<string, unknown> };

// Every test runs with analytics on (playwright.config.ts). PostHog requests are answered
// here so nothing leaves the browser, and the events are kept for tests that check them.
export const test = base.extend<{ analytics: Captured[] }>({
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
