import posthog from "posthog-js";
import type { Account } from "./contracts";

// Product analytics (TRACKING-PLAN 1, 2). Off when no key is set, e.g. local mock runs and tests.
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
// Same-origin path that next.config.ts rewrites to PostHog, so ad blockers do not drop events.
const API_HOST = "/ingest";
const UI_HOST = "https://us.posthog.com";

let current: { id: string; member: boolean } | null = null;

function superProperties() {
  return {
    environment: process.env.NEXT_PUBLIC_APP_ENV ?? "dev",
    app_release: process.env.NEXT_PUBLIC_APP_RELEASE ?? "local",
  };
}

function bootstrap(account: Account) {
  return {
    distinctID: account.account_id,
    // Guests stay anonymous so a later login can merge them into the member.
    isIdentifiedID: !account.is_guest,
  };
}

/**
 * Points PostHog at the account the server issued. Called on every account change.
 * PostHog starts only here, after the guest account ID exists, so the first-visit
 * referrer and UTM values land on the same person as the server and AI records.
 */
export function syncAnalyticsAccount(account: Account) {
  if (!key || typeof window === "undefined") return;
  const member = !account.is_guest;
  if (current === null) {
    posthog.init(key, {
      api_host: API_HOST,
      ui_host: UI_HOST,
      bootstrap: bootstrap(account),
      person_profiles: "always",
      capture_pageview: "history_change",
      capture_pageleave: false,
      autocapture: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
    });
    posthog.register(superProperties());
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
  current = { id: account.account_id, member };
}

function restart(account: Account) {
  posthog.reset({ bootstrap: bootstrap(account) });
  posthog.register(superProperties());
}
