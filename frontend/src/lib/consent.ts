import type { Account } from "./contracts";

// The browser remembers the required consent versions it has agreed to (ACCOUNT web 2-2-6),
// so the guest that a logout leaves behind is not asked again. Only a guest is let through by
// it: a member is always judged by its own records on the server.
const COOKIE = "dopia_consents";
const MAX_AGE = 60 * 60 * 24 * 365;

function required(account: Account) {
  return account.consent_items
    .filter((item) => item.required)
    .map((item) => `${item.id}@${item.version}`);
}

function stored(): string[] {
  const match = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${COOKIE}=`));
  return match
    ? decodeURIComponent(match.slice(COOKIE.length + 1)).split(",")
    : [];
}

/** The account as the screens see it: a guest on a browser that already agreed needs nothing. */
export function withBrowserConsent(account: Account): Account {
  if (!account.consent_required) {
    remember(account);
    return account;
  }
  if (!account.is_guest) return account;
  const agreed = stored();
  return required(account).every((value) => agreed.includes(value))
    ? { ...account, consent_required: false }
    : account;
}

function remember(account: Account) {
  const values = required(account);
  if (!values.length) return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${encodeURIComponent(values.join(","))}; Max-Age=${MAX_AGE}; Path=/; SameSite=Lax${secure}`;
}

/** A withdrawal leaves nothing behind: the next visit is asked again. */
export function forgetBrowserConsent() {
  document.cookie = `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}
