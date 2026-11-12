import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/contracts";

// PostHog drops events from automated browsers as bots, so e2e cannot see analytics.
// These tests swap posthog-js for a fake that keeps PostHog's own rules that matter here:
// register() adds super properties to every later event and reset() wipes them.
type Call = [string, ...unknown[]];
const calls: Call[] = [];
let distinctId = "";
function fake(prefix: string) {
  const instance = {
    superProperties: {} as Record<string, unknown>,
    init: vi.fn(
      (
        _key: string,
        config: { bootstrap?: { distinctID: string } },
        name?: string,
      ) => {
        calls.push([`${prefix}init`, name ?? "main"]);
        if (name) return before;
        distinctId = config.bootstrap?.distinctID ?? "";
        return main;
      },
    ),
    register: vi.fn((props: Record<string, unknown>) => {
      Object.assign(instance.superProperties, props);
      calls.push([`${prefix}register`, props]);
    }),
    identify: vi.fn((id: string) => {
      distinctId = id;
      calls.push([`${prefix}identify`, id]);
    }),
    reset: vi.fn((options: { bootstrap: { distinctID: string } }) => {
      distinctId = options.bootstrap.distinctID;
      instance.superProperties = {};
      calls.push([`${prefix}reset`, options.bootstrap]);
    }),
    // What PostHog would send: super properties, then the event's own.
    capture: vi.fn((event: string, props: object) =>
      calls.push([
        `${prefix}capture`,
        event,
        { ...instance.superProperties, ...props },
      ]),
    ),
    get_distinct_id: vi.fn(() => distinctId),
  };
  return instance;
}
const main = fake("");
const before = fake("before.");
vi.mock("posthog-js", () => ({ default: main }));

const guest: Account = {
  account_id: "guest-1",
  is_guest: true,
  nickname: null,
  photo_url: null,
  adult_mode: false,
  adult_verified: false,
  adult_verification_rejected: false,
  consent_required: false,
  consent_items: [],
};
const member: Account = { ...guest, account_id: "member-1", is_guest: false };

async function load() {
  vi.resetModules();
  return import("@/lib/analytics");
}
const named = (name: string) => calls.filter(([n]) => n === name);
/** The page's `<html>`, whose `data-theme` the layout script sets before first paint. */
function screenTheme(theme: "dark" | "light") {
  const root = { dataset: { theme } };
  vi.stubGlobal("document", { documentElement: root });
  return root;
}
const lastRegister = () => main.superProperties;

beforeEach(() => {
  vi.clearAllMocks();
  main.superProperties = {};
  before.superProperties = {};
  calls.length = 0;
  distinctId = "";
  vi.stubGlobal("window", {});
  vi.stubEnv("NEXT_PUBLIC_DEV_POSTHOG_API_KEY", "phc_test");
  vi.stubEnv("NEXT_PUBLIC_PROD_POSTHOG_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("analytics identity", () => {
  it("starts as the guest the server issued, anonymous", async () => {
    const analytics = await load();
    analytics.setAnalyticsLocale("ko-KR");
    analytics.syncAnalyticsAccount(guest);
    expect(main.init).toHaveBeenCalledOnce();
    const config = main.init.mock.calls[0][1] as {
      bootstrap: { distinctID: string; isIdentifiedID: boolean };
    };
    expect(config.bootstrap).toEqual({
      distinctID: "guest-1",
      isIdentifiedID: false,
    });
    expect(named("reset")).toHaveLength(0);
    expect(lastRegister()).toMatchObject({
      is_member: false,
      adult_mode: false,
      locale: "ko-KR",
      // Dark is the default when nothing else is on screen.
      theme: "dark",
    });
  });

  it("reports the theme on screen and follows a change", async () => {
    const root = screenTheme("light");
    const analytics = await load();
    analytics.syncAnalyticsAccount(guest);
    expect(lastRegister()).toMatchObject({ theme: "light" });
    root.dataset.theme = "dark";
    analytics.syncAnalyticsTheme();
    expect(lastRegister()).toMatchObject({ theme: "dark" });
    // reset() on logout wipes it; the next account's register puts it back.
    analytics.syncAnalyticsAccount({ ...guest, account_id: "guest-2" });
    analytics.track("home_viewed", "home");
    expect(named("capture").at(-1)?.[2]).toMatchObject({ theme: "dark" });
  });

  it("merges the guest into the member on login and starts over as a new guest on logout", async () => {
    const analytics = await load();
    analytics.syncAnalyticsAccount(guest);
    analytics.syncAnalyticsAccount(member);
    expect(named("identify")).toEqual([["identify", "member-1"]]);
    expect(lastRegister()).toMatchObject({ is_member: true });
    analytics.syncAnalyticsAccount({ ...guest, account_id: "guest-2" });
    expect(named("reset")).toEqual([
      ["reset", { distinctID: "guest-2", isIdentifiedID: false }],
    ]);
    // reset() wiped the super properties; events after logout must still carry them.
    analytics.track("home_viewed", "home");
    expect(named("capture").at(-1)?.[2]).toMatchObject({
      page: "home",
      is_member: false,
      adult_mode: false,
      app_release: "local",
    });
  });

  it("replaces an ID stored by an earlier visit with the server's", async () => {
    main.init.mockImplementationOnce(() => {
      distinctId = "stale";
      return main;
    });
    const analytics = await load();
    analytics.syncAnalyticsAccount(guest);
    expect(named("reset")).toEqual([
      ["reset", { distinctID: "guest-1", isIdentifiedID: false }],
    ]);
  });

  it("reports adult mode only for a verified member who turned it on", async () => {
    const analytics = await load();
    analytics.syncAnalyticsAccount({ ...guest, adult_mode: true });
    expect(lastRegister()).toMatchObject({ adult_mode: false });
    analytics.syncAnalyticsAccount({
      ...member,
      adult_mode: true,
      adult_verified: true,
      adult_verification_rejected: false,
      consent_required: false,
      consent_items: [],
    });
    expect(lastRegister()).toMatchObject({ adult_mode: true });
  });
});

describe("analytics events", () => {
  it("adds the page and drops events until PostHog has started", async () => {
    const analytics = await load();
    analytics.track("home_viewed", "home");
    expect(named("capture")).toHaveLength(0);
    analytics.syncAnalyticsAccount(guest);
    analytics.track("home_viewed", "home", { load_result: "loaded" });
    expect(named("capture")).toHaveLength(1);
    expect(named("capture")[0][2]).toMatchObject({
      load_result: "loaded",
      page: "home",
      is_member: false,
    });
  });

  it("records the session failure screen on a separate temporary instance", async () => {
    screenTheme("light");
    const analytics = await load();
    analytics.setAnalyticsLocale("zh-TW");
    analytics.trackBeforeSession("error_screen_viewed", {
      target: "session",
      code: "unknown",
    });
    analytics.trackBeforeSession("retry_clicked", { target: "session" });
    expect(main.init.mock.calls[0][2]).toBe("before_session");
    expect(
      (main.init.mock.calls[0][1] as { persistence: string }).persistence,
    ).toBe("memory");
    const sent = named("before.capture");
    expect(sent.map(([, event]) => event)).toEqual([
      "error_screen_viewed",
      "retry_clicked",
    ]);
    expect(sent[0][2]).toMatchObject({
      target: "session",
      code: "unknown",
      page: "error",
      locale: "zh-TW",
      theme: "light",
    });
    // The account is unknown before the session exists.
    for (const [, , props] of sent) {
      expect(props).not.toHaveProperty("is_member");
      expect(props).not.toHaveProperty("adult_mode");
    }
    expect(named("capture")).toHaveLength(0);
  });

  it("does nothing without a key", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_POSTHOG_API_KEY", "");
    const analytics = await load();
    analytics.syncAnalyticsAccount(guest);
    analytics.track("home_viewed", "home");
    analytics.trackBeforeSession("retry_clicked");
    expect(calls).toHaveLength(0);
  });
});
