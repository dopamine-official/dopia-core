import { type Page } from "@playwright/test";

/**
 * Changes how the app's own API calls are answered, inside the page. The mock API answers
 * from a service worker, which Playwright's request routing does not see.
 * - `status`: answer with this error status and code `e2e_down`.
 * - `delay`: wait this long (ms) before the real call.
 * - `merge`: merge these fields into a successful JSON answer.
 * - `account`: answer 200 with the last account seen, plus these fields.
 */
export type Stub = {
  path: string;
  method?: string;
  status?: number;
  delay?: number;
  merge?: Record<string, unknown>;
  account?: Record<string, unknown>;
};
type StubWindow = Window & {
  e2eStubs: Stub[];
  e2eAccount: Record<string, unknown> | null;
};

export async function installStubs(page: Page, stubs: Stub[] = []) {
  await page.addInitScript((initial) => {
    const w = window as unknown as StubWindow;
    w.e2eStubs = initial;
    w.e2eAccount = null;
    const original = window.fetch.bind(window);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    window.fetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const stub = w.e2eStubs.find(
        (item) =>
          item.path === url.pathname &&
          (!item.method || item.method === method),
      );
      if (stub?.delay) await new Promise((r) => setTimeout(r, stub.delay));
      if (stub?.status) return json({ code: "e2e_down" }, stub.status);
      if (stub?.account) return json({ ...w.e2eAccount, ...stub.account });
      const response = await original(input, init);
      const isJson = response.headers
        .get("content-type")
        ?.includes("application/json");
      if (!response.ok || !isJson || !url.pathname.startsWith("/api/"))
        return response;
      const body = await response.clone().json();
      const merged = stub?.merge ? { ...body, ...stub.merge } : body;
      if (merged && typeof merged === "object" && "is_guest" in merged)
        w.e2eAccount = merged;
      return stub?.merge ? json(merged, response.status) : response;
    };
  }, stubs);
}
/** Replaces the stubs of a page already loaded. */
export async function setStubs(page: Page, stubs: Stub[]) {
  await page.evaluate((next) => {
    (window as unknown as StubWindow).e2eStubs = next;
  }, stubs);
}
