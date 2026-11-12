import { defineConfig, devices } from "@playwright/test";

// Tests always start their own server. Borrowing a dev server already running on the port
// would run without the analytics settings below and fail the event checks for no reason;
// with reuseExistingServer off, Playwright stops at once and says the port is in use.
const port = 3000;
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 12_000 },
  // One test at a time against one dev server. Tests do not depend on each other, so CI can
  // split them evenly by test, not by file (.github/workflows/check.yml).
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: origin,
    // First visits follow the browser language; tests are written in Korean.
    locale: "ko-KR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "allow",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: origin,
    // Analytics on, so tests can read events; tests/e2e/fixtures.ts keeps them in the browser.
    env: {
      ...process.env,
      NEXT_PUBLIC_DEV_POSTHOG_API_KEY: "phc_e2e",
      // PostHog's shortest batch interval; tests/e2e/fixtures.ts `settle` waits a few of them.
      NEXT_PUBLIC_POSTHOG_FLUSH_MS: "250",
      // Tests run against src/mocks/characters.fixture.ts, not the preview characters.
      NEXT_PUBLIC_MOCK_FIXTURES: "test",
    } as Record<string, string>,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
