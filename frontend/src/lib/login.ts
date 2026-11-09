import type { Page } from "./analytics";

/** Why the login modal opened (TRACKING-PLAN 4). */
export type LoginTrigger =
  | "login_button"
  | "safe_toggle"
  | "turn_limit"
  | "members_only"
  | "login_failed"
  | "login_cancelled";
export type LoginProvider = "google";
/** Screens a login modal can be on. */
export type LoginPage = Exclude<Page, "error">;

/** How the provider round trip that started on this tab ended, known on the way back. */
export type LoginReturn = {
  provider: LoginProvider;
  // Why the modal had opened before leaving for the provider.
  trigger: LoginTrigger;
  // The screen the modal was on; the provider may return to another one.
  page: LoginPage | null;
  outcome: "succeeded" | "failed" | "cancelled";
};

// Kept in the tab across the provider round trip, which leaves this app and comes back.
const KEY = "dopia:login";
// An older note is from a round trip that never came back here.
const MAX_AGE = 30 * 60_000;
const providers: readonly string[] = ["google"];
const pages: readonly string[] = ["home", "chat_room", "me", "not_found"];
const triggers: readonly string[] = [
  "login_button",
  "safe_toggle",
  "turn_limit",
  "members_only",
  "login_failed",
  "login_cancelled",
];

/** Notes the provider, trigger and screen just before leaving for the provider. */
export function saveLoginStart(
  provider: LoginProvider,
  trigger: LoginTrigger,
  page: LoginPage | null,
) {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ provider, trigger, page, at: Date.now() }),
    );
  } catch {
    // Without storage the result is not recorded; login itself still works.
  }
}

/** Drops the note: the visitor came back without finishing the round trip. */
export function clearLoginStart() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Reads and clears the note on the first page after the round trip. The server returns a
 * member on success, a guest with `?login=1&error=login_failed` on failure, and a guest
 * with `?login=1` alone on cancel. Anything else is not a return from the provider.
 */
export function takeLoginReturn(
  isMember: boolean,
  search: string,
): LoginReturn | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let saved: {
    provider?: unknown;
    trigger?: unknown;
    page?: unknown;
    at?: unknown;
  };
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof saved.provider !== "string" ||
    !providers.includes(saved.provider) ||
    typeof saved.trigger !== "string" ||
    !triggers.includes(saved.trigger) ||
    typeof saved.at !== "number" ||
    Date.now() - saved.at > MAX_AGE
  )
    return null;
  const base = {
    provider: saved.provider as LoginProvider,
    trigger: saved.trigger as LoginTrigger,
    page:
      typeof saved.page === "string" && pages.includes(saved.page)
        ? (saved.page as LoginPage)
        : null,
  };
  if (isMember) return { ...base, outcome: "succeeded" };
  const params = new URLSearchParams(search);
  if (params.get("login") !== "1") return null;
  return {
    ...base,
    outcome: params.get("error") === "login_failed" ? "failed" : "cancelled",
  };
}

/** The screen under the login modal, for `page`; null where nothing is recorded. */
export function pageForPath(path: string): LoginPage | null {
  if (path === "/") return "home";
  if (path === "/me") return "me";
  if (/^\/chats\/[^/]+$/.test(path)) return "chat_room";
  // Design preview and e2e-only screens are not part of the product.
  if (path === "/preview" || path.startsWith("/e2e/")) return null;
  return "not_found";
}
