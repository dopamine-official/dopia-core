import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
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
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    // Analytics on, so tests can read events; tests/e2e/fixtures.ts keeps them in the browser.
    env: {
      ...process.env,
      NEXT_PUBLIC_POSTHOG_KEY: "phc_e2e",
      NEXT_PUBLIC_APP_ENV: "dev",
    } as Record<string, string>,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
