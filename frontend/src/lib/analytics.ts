import posthog, { type PostHog, type PostHogConfig } from "posthog-js";
import { ApiError, type Account } from "./contracts";

// Product analytics (TRACKING-PLAN 1, 2). Off when no key is set, e.g. local mock runs and tests.
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const enabled = () => !!key && typeof window !== "undefined";

/** Screen names for the `page` property (TRACKING-PLAN 3, 5, 6, 7). Never a path. */
export type Page = "home" | "chat_room" | "me" | "not_found" | "error";
export type EventProperties = Record<
  string,
  string | number | boolean | string[] | null
>;

// Shared by both instances: same-origin route (src/app/ingest) so ad blockers do not drop
// events, and nothing loaded or collected beyond the events this app sends itself.
const BASE_CONFIG: Partial<PostHogConfig> = {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  capture_pageleave: false,
  autocapture: false,
  disable_session_recording: true,
  disable_surveys: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  // PostHog drops automated browsers as bots. In dev, keep them so e2e can check events;
  // PostHog hides `dev` records from every chart anyway.
  opt_out_useragent_filter: process.env.NEXT_PUBLIC_APP_ENV === "dev",
  // e2e sends each batch sooner so its checks wait less (playwright.config.ts). Unset, the
  // PostHog default (3 seconds) applies.
  ...(process.env.NEXT_PUBLIC_POSTHOG_FLUSH_MS
    ? {
        request_queue_config: {
          flush_interval_ms: Number(process.env.NEXT_PUBLIC_POSTHOG_FLUSH_MS),
        },
      }
    : {}),
};

function releaseProperties() {
  return {
    // dev or prod; next.config.ts refuses to start without it when the key is set.
    environment: process.env.NEXT_PUBLIC_APP_ENV,
    app_release: process.env.NEXT_PUBLIC_APP_RELEASE ?? "local",
  };
}

let current: { id: string; member: boolean } | null = null;
let locale: string | null = null;

/** The theme on screen; `layout.tsx` sets it before first paint, dark by default. */
function currentTheme() {
  return globalThis.document?.documentElement.dataset.theme === "light"
    ? "light"
    : "dark";
}

function bootstrap(account: Account) {
  return {
    distinctID: account.account_id,
    // Guests stay anonymous so a later login can merge them into the member.
    isIdentifiedID: !account.is_guest,
  };
}

/** The web common properties that come from the account (TRACKING-PLAN 1). */
function accountProperties(account: Account) {
  return {
    is_member: !account.is_guest,
    // Same rule as the SAFE toggle: only a verified member can have adult mode on.
    adult_mode:
      !account.is_guest && account.adult_verified && account.adult_mode,
  };
}

function registerAll(account: Account) {
  posthog.register({
    ...releaseProperties(),
    ...accountProperties(account),
    ...(locale ? { locale } : {}),
    theme: currentTheme(),
  });
}

/**
 * Points PostHog at the account the server issued. Called on every account change.
 * PostHog starts only here, after the guest account ID exists, so the first-visit
 * referrer and UTM values land on the same person as the server and AI records.
 */
export function syncAnalyticsAccount(account: Account) {
  if (!enabled()) return;
  const member = !account.is_guest;
  if (current === null) {
    posthog.init(key!, {
      ...BASE_CONFIG,
      bootstrap: bootstrap(account),
      person_profiles: "always",
      capture_pageview: "history_change",
    });
    // A stored ID from an earlier visit wins over bootstrap; replace it with the server's.
    if (posthog.get_distinct_id() !== account.account_id) restart(account);
  } else if (current.id !== account.account_id) {
    if (member && !current.member) {
      // Guest logged in: the guest's history joins the member.
      posthog.identify(account.account_id);
    } else {
      // Logout, withdrawal, or a switch between members: start over as the new account.
      restart(account);
    }
  }
  registerAll(account);
  current = { id: account.account_id, member };
}

function restart(account: Account) {
  posthog.reset({ bootstrap: bootstrap(account) });
}

/** Keeps the `locale` common property in step with the screen language. */
export function setAnalyticsLocale(next: string) {
  locale = next;
  if (enabled() && current !== null) posthog.register({ locale });
}

/** Keeps the `theme` common property in step with the theme on screen. */
export function syncAnalyticsTheme() {
  if (enabled() && current !== null)
    posthog.register({ theme: currentTheme() });
}

/** Sends a web event with the common properties; `page` names the screen it happened on. */
export function track(
  event: string,
  page: Page,
  properties: EventProperties = {},
) {
  if (!enabled() || current === null) return;
  posthog.capture(event, { ...properties, page });
}

// Before the session exists there is no account ID to record under. The session failure
// screen still has to be counted, so its events go out under a temporary anonymous ID on a
// separate instance that never touches the main one's storage. These records do not join
// the visitor's later history (TRACKING-PLAN 1).
let beforeSession: PostHog | null = null;

export function trackBeforeSession(
  event: string,
  properties: EventProperties = {},
) {
  if (!enabled()) return;
  if (beforeSession === null) {
    beforeSession =
      posthog.init(
        key!,
        {
          ...BASE_CONFIG,
          persistence: "memory",
          person_profiles: "identified_only",
          capture_pageview: false,
        },
        "before_session",
      ) ?? null;
    beforeSession?.register({
      ...releaseProperties(),
      ...(locale ? { locale } : {}),
    });
  }
  // The account is unknown here, so is_member and adult_mode are left out.
  beforeSession?.capture(event, { ...properties, page: "error" });
}

/** The error code for the `code` property; `unknown` when there is none. */
export function errorCode(error: unknown): string {
  return error instanceof ApiError && error.code ? error.code : "unknown";
}
