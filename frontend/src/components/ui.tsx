"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ageConfig,
  localeNames,
  regionToday,
  supportedLocales,
  type Locale,
} from "@/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { api, readAccount, refreshSession } from "@/lib/api";
import {
  accountIdentitySchema,
  accountSchema,
  ApiError,
} from "@/lib/contracts";
import { errorMessageKey } from "@/lib/errors";
import { errorCode, track, type EventProperties } from "@/lib/analytics";
import {
  clearLoginStart,
  pageForPath,
  saveLoginStart,
  type LoginPage,
  type LoginProvider,
} from "@/lib/login";
import {
  useSession,
  type AdultVerificationRequest,
  type LoginRequest,
} from "./providers";
import { useTrack } from "./page";
import { forgetBrowserConsent } from "@/lib/consent";

export function Icon({
  name,
}: {
  name:
    | "menu"
    | "close"
    | "send"
    | "edit"
    | "arrow"
    | "down"
    | "trash"
    | "chat"
    | "reset"
    | "globe"
    | "more";
}) {
  const paths = {
    menu: "M4 6h16M4 12h16M4 18h16",
    close: "m6 6 12 12M18 6 6 18",
    send: "M12 19V5m-6 6 6-6 6 6",
    edit: "m16 3 5 5M4 15 16 3a2.1 2.1 0 0 1 5 5L9 20l-6 1z",
    arrow: "m9 5 7 7-7 7",
    down: "M12 5v14m-6-6 6 6 6-6",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
    chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2-5a8.5 8.5 0 1 1 16-3.5Z",
    reset: "M3 10a9 9 0 1 1 2 8M3 3v7h7",
    globe: "M3 12h18M12 3c6 5 6 13 0 18M12 3c-6 5-6 13 0 18",
    more: "",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "globe" && <circle cx="12" cy="12" r="9" />}
      {name === "more" &&
        [5, 12, 19].map((cx) => (
          <circle
            key={cx}
            cx={cx}
            cy="12"
            r="1.6"
            fill="currentColor"
            stroke="none"
          />
        ))}
      <path d={paths[name]} />
    </svg>
  );
}
export function LocaleSelect() {
  const { locale, setLocale, t } = useSession();
  const send = useTrack();
  return (
    <label className="language_select">
      <Icon name="globe" />
      <span className="sr_only">{t("common.language")}</span>
      <select
        value={locale}
        onChange={(e) => {
          const next = e.target.value as Locale;
          send("locale_changed", { from: locale, to: next });
          setLocale(next);
        }}
      >
        {supportedLocales.map((value) => (
          <option key={value} value={value}>
            {localeNames[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
export function Avatar({
  photo,
  name,
  large = false,
}: {
  photo: string | null;
  name: string | null;
  large?: boolean;
}) {
  return (
    <span className={`avatar ${large ? "large" : ""}`}>
      {photo ? <img src={photo} alt="" /> : (name?.[0] ?? "G")}
    </span>
  );
}
export function SiteHeader({
  menu,
  safe = false,
}: {
  menu?: { open: boolean; toggle: () => void };
  safe?: boolean;
}) {
  const { t, account, openLogin } = useSession();
  const send = useTrack();
  return (
    <header className="site_header">
      <div className="header_start">
        {menu && (
          <button
            className="icon_button"
            aria-label={t("common.menu")}
            aria-expanded={menu.open}
            onClick={menu.toggle}
          >
            <Icon name="menu" />
          </button>
        )}
        <Link className="brand" href="/" onClick={() => send("logo_clicked")}>
          {t("common.brand")}
        </Link>
      </div>
      <div className="header_actions">
        <LocaleSelect />
        {safe && (
          <SafeToggle onLogin={() => openLogin({ trigger: "safe_toggle" })} />
        )}
        {account.is_guest ? (
          <button
            type="button"
            className="login_link"
            aria-haspopup="dialog"
            onClick={() => {
              send("login_link_clicked");
              openLogin({ trigger: "login_button" });
            }}
          >
            {t("account.login.button")}
          </button>
        ) : (
          <ProfileMenu />
        )}
      </div>
    </header>
  );
}
/**
 * Records an event of a modal drawn over every screen (consent, adult verification), on the
 * screen under it (TRACKING-PLAN 9): those modals sit outside any screen's context.
 */
function useOverlayTrack() {
  const page = pageForPath(usePathname());
  return useCallback(
    (event: string, properties?: EventProperties) => {
      if (page) track(event, page, properties);
    },
    [page],
  );
}
/** Records a login event on the screen under the modal (TRACKING-PLAN 4). */
function useLoginTrack() {
  const page = pageForPath(usePathname());
  const send = (event: string, properties: EventProperties) => {
    if (page) track(event, page, properties);
  };
  return { page, send };
}
// Showings already recorded; React's dev double mount must not count one twice.
const viewedLogins = new Set<number>();
export function LoginHost() {
  const { t, login, closeLogin } = useSession();
  const { page, send } = useLoginTrack();
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    if (!login || viewedLogins.has(login.id)) return;
    viewedLogins.add(login.id);
    sendRef.current("login_modal_viewed", { trigger: login.trigger });
    if (login.failed) {
      // On the screen the modal was opened from, like the click it answers.
      const properties = {
        provider: login.failed.provider,
        trigger: login.failed.trigger,
      };
      if (login.failed.page)
        track("login_failed", login.failed.page, properties);
      else sendRef.current("login_failed", properties);
    }
  }, [login]);
  if (!login) return null;
  return (
    <Modal
      title={t("account.login.title")}
      className="login_modal"
      onClose={(method) => {
        send("login_modal_closed", { trigger: login.trigger, method });
        closeLogin();
      }}
    >
      <p className="muted">{t("account.login.description")}</p>
      <LoginOptions login={login} page={page} send={send} />
    </Modal>
  );
}
function LoginOptions({
  login,
  page,
  send,
}: {
  login: LoginRequest;
  page: LoginPage | null;
  send: (event: string, properties: EventProperties) => void;
}) {
  const { t, changeAccount } = useSession();
  const { returnTo, trigger } = login;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(login.error);
  useEffect(() => {
    // Back from the provider page without finishing: the browser restores this page as it
    // was left, buttons still waiting. Let the visitor try again, and forget the round trip
    // so a later visit is not taken for its end.
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      clearLoginStart();
      setBusy(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  async function signIn(provider: LoginProvider) {
    if (busy) return;
    setBusy(provider);
    setError("");
    send("login_provider_clicked", { provider, trigger });
    if (process.env.NEXT_PUBLIC_LOGIN === "oauth") {
      // The result is known only on the way back (src/lib/login.ts).
      saveLoginStart(provider, trigger, page);
      // The server starts the provider flow and returns here by redirect.
      window.location.assign(
        `/api/v1/account/auth/${provider}/start?return_to=${encodeURIComponent(returnTo)}`,
      );
      return;
    }
    try {
      const next = await api("/mock/login", accountSchema, {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      changeAccount(next, returnTo);
      // After the account change, so the event belongs to the member.
      send("login_succeeded", { provider, trigger });
    } catch (error) {
      setBusy(null);
      setError(errorMessageKey(error, "account.login.failed"));
      send("login_failed", { provider, trigger });
    }
  }
  return (
    <>
      <div className="login_buttons">
        <button
          className="button provider google"
          disabled={!!busy}
          onClick={() => void signIn("google")}
        >
          <b className="google_mark" aria-hidden="true">
            G
          </b>
          {t("account.login.google")}
        </button>
      </div>
      {error && (
        <p className="inline_error" role="alert">
          {t(error)}
        </p>
      )}
      <p className="login_note">{t("account.login.note")}</p>
    </>
  );
}
type ProfileMenuItem =
  "profile" | "charge" | "my_characters" | "create_character" | "logout";
/**
 * Logout or withdrawal, then home as the new guest (ACCOUNT web 3-2). Success resets PostHog,
 * so only the server records it (TRACKING-PLAN 6).
 */
// One logout or withdrawal at a time across the profile menu and My Page: a second click
// would run as the new guest and fail.
let leaveInFlight = false;
export function useLeave() {
  const { t, changeAccount, notice } = useSession();
  const send = useTrack();
  const [busy, setBusy] = useState(false);
  async function leave(remove = false, onFailed?: () => void) {
    if (leaveInFlight) return;
    leaveInFlight = true;
    send(remove ? "withdraw_confirmed" : "logout_clicked");
    setBusy(true);
    try {
      const issued = await api(
        remove ? "/account/withdraw" : "/account/logout",
        accountIdentitySchema,
        { method: "POST" },
      );
      if (remove) forgetBrowserConsent();
      changeAccount(await readAccount(issued.account_id), "/");
      leaveInFlight = false;
    } catch (error) {
      leaveInFlight = false;
      onFailed?.();
      send(remove ? "withdraw_failed" : "logout_failed", {
        code: errorCode(error),
      });
      notice(t(errorMessageKey(error)));
      setBusy(false);
    }
  }
  return { busy, leave };
}
// PostHog flag `character_creation_enabled` is not wired yet; the spec's default (and unreadable) value is false.
const characterCreationEnabled = false;
export function ProfileMenu() {
  const { t, account } = useSession();
  const send = useTrack();
  const [open, setOpen] = useState(false);
  const [charge, setCharge] = useState(false);
  const { busy: leaving, leave } = useLeave();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const choose = (item: ProfileMenuItem, focusButton = false) => {
    send("profile_menu_item_clicked", { item });
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (wrap.current?.contains(event.target as Node)) return;
      send("profile_menu_closed", { method: "outside" });
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      send("profile_menu_closed", { method: "escape" });
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, send]);
  return (
    <div className="profile_menu_wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="profile_button"
        aria-label={t("account.menu.profile_button")}
        aria-expanded={open}
        aria-controls="profile_menu"
        onClick={() => {
          send("profile_button_clicked", { open: !open });
          setOpen(!open);
        }}
      >
        <Avatar photo={account.photo_url} name={account.nickname} />
      </button>
      {open && (
        <nav
          id="profile_menu"
          ref={panel}
          className="profile_menu"
          aria-label={t("account.menu.name")}
        >
          <Link
            href="/me"
            className="menu_profile"
            onClick={() => choose("profile")}
          >
            <Avatar photo={account.photo_url} name={account.nickname} />
            <strong>{account.nickname}</strong>
          </Link>
          <hr />
          <div className="menu_line">
            <span>
              {t("account.menu.credit")} <strong>-</strong>
            </span>
            <button
              type="button"
              className="menu_button"
              aria-haspopup="dialog"
              onClick={() => {
                choose("charge", true);
                setCharge(true);
              }}
            >
              {t("account.menu.charge")}
            </button>
          </div>
          {characterCreationEnabled && (
            <>
              <hr />
              <div className="menu_line">
                <Link
                  href="/characters/mine"
                  onClick={() => choose("my_characters")}
                >
                  {t("account.menu.my_characters")}
                </Link>
                <Link
                  href="/characters/new"
                  className="menu_button ghost"
                  onClick={() => choose("create_character")}
                >
                  {t("account.menu.create_character")}
                </Link>
              </div>
            </>
          )}
          <hr />
          <button
            type="button"
            className="menu_logout danger"
            disabled={leaving}
            onClick={() => {
              // Closes like every other item; a failure shows only its toast.
              choose("logout", true);
              void leave();
            }}
          >
            {t("account.me.logout")}
          </button>
        </nav>
      )}
      {charge && (
        <Modal
          title={t("account.menu.charge_title")}
          onClose={() => setCharge(false)}
        >
          <div className="policy_body">
            {t("account.menu.charge_placeholder")}
          </div>
        </Modal>
      )}
    </div>
  );
}
function SafeToggle({ onLogin }: { onLogin: () => void }) {
  const { account, changeAccount, t, notice, openAdultVerification } =
    useSession();
  const send = useTrack();
  const [busy, setBusy] = useState(false);
  const adultMode =
    !account.is_guest && account.adult_verified && account.adult_mode;
  return (
    <button
      role="switch"
      aria-checked={!adultMode}
      aria-label={t("character.safe")}
      className={`safe_toggle ${adultMode ? "" : "on"}`}
      disabled={busy}
      onClick={async () => {
        if (busy) return;
        // SAFE on means adult mode off.
        const to = adultMode ? "safe_on" : "safe_off";
        const finish = (result: string) =>
          send("safe_toggle_finished", { to, result });
        send("safe_toggle_clicked", { to });
        if (account.is_guest) {
          finish("login_required");
          onLogin();
          return;
        }
        if (account.adult_verification_rejected) {
          finish("verification_rejected");
          notice(t("character.adult_verification_rejected"));
          return;
        }
        if (!account.adult_verified) {
          finish("verification_required");
          // Passing turns adult mode on, so no separate change request (ACCOUNT web 2-2-7).
          openAdultVerification({ onPassed: (next) => changeAccount(next) });
          return;
        }
        setBusy(true);
        let next;
        try {
          next = await api("/account/me/adult_mode", accountSchema, {
            method: "PATCH",
            body: JSON.stringify({ adult_mode: !adultMode }),
          });
        } catch (error) {
          finish("failed");
          notice(t(errorMessageKey(error)));
          setBusy(false);
          return;
        }
        // Before the account changes, so the event still carries the mode it was sent from.
        finish("applied");
        changeAccount(next);
        setBusy(false);
      }}
    >
      <span>SAFE</span>
      <span className="safe_track">
        <span />
      </span>
      <span className="safe_value">{adultMode ? "OFF" : "ON"}</span>
    </button>
  );
}
/** How a modal was closed: its close button, a click outside, or `Esc`. */
export type CloseReason = "button" | "outside" | "escape";
/**
 * Cmd+B on a Mac, Ctrl+B elsewhere, toggles the sidebar. Read by key position so a Korean
 * layout works too; a held key toggles once, and another dialog on top keeps it closed.
 */
export function useSidebarShortcut(toggle: () => void) {
  const latest = useRef(toggle);
  useLayoutEffect(() => {
    latest.current = toggle;
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.code !== "KeyB") return;
      e.preventDefault();
      if (e.repeat) return;
      if (document.querySelector("dialog[open]:not(.drawer)")) return;
      latest.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
export function Modal({
  title,
  titleContent,
  children,
  onClose,
  drawer = false,
  closeLabel,
  className,
  locked = false,
}: {
  title: string;
  titleContent?: ReactNode;
  children: ReactNode;
  onClose: (reason: CloseReason) => void;
  drawer?: boolean;
  closeLabel?: string;
  className?: string;
  // No close button; `Esc` and a click outside do nothing.
  locked?: boolean;
}) {
  const { t } = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  const lockedRef = useRef(locked);
  useLayoutEffect(() => {
    close.current = onClose;
    lockedRef.current = locked;
  });
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement;
    let mounted = true;
    // Browsers may still close a modal whose cancel was prevented (a second `Esc`).
    const reopen = () => {
      if (mounted && lockedRef.current && !dialog.open) dialog.showModal();
    };
    dialog.addEventListener("close", reopen);
    dialog.showModal();
    if (drawer) closeButton.current?.focus();
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      mounted = false;
      dialog.removeEventListener("close", reopen);
      dialog.close();
      document.body.style.overflow = before;
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, [drawer]);
  return (
    <dialog
      ref={ref}
      className={[drawer ? "drawer" : "modal", className]
        .filter(Boolean)
        .join(" ")}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) close.current("escape");
      }}
      onClick={(e) => {
        // A click outside closes a modal; the sidebar drawer stays open until closed on purpose.
        if (!drawer && !locked && e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            close.current("outside");
        }
      }}
    >
      <div className="modal_heading">
        <h2>{titleContent ?? title}</h2>
        {!locked && (
          <button
            ref={closeButton}
            className="icon_button"
            onClick={() => onClose("button")}
            aria-label={closeLabel ?? t("common.close")}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}
export function ErrorState({
  retry,
  message,
  error,
  onShown,
}: {
  retry: () => void;
  message?: string;
  error?: unknown;
  // Runs when the notice is first actually on screen, not when it is only rendered: a
  // hidden sidebar or a closed drawer can hold it out of sight.
  onShown?: () => void;
}) {
  const { t } = useSession();
  const box = useRef<HTMLDivElement>(null);
  const shown = useRef(onShown);
  useLayoutEffect(() => {
    shown.current = onShown;
  });
  const watch = !!onShown;
  useEffect(() => {
    const node = box.current;
    if (!watch || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Edge contact (a sidebar slid just off screen) reports a ratio of 0.
        if (!entries.some((entry) => entry.intersectionRatio > 0)) return;
        observer.disconnect();
        shown.current?.();
      },
      { threshold: [0, 0.01] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [watch]);
  return (
    <div className="empty_state" ref={box}>
      <p role="alert">
        {message ?? t(errorMessageKey(error, "common.load_failed"))}
      </p>
      <button className="button" onClick={retry}>
        {t("common.retry")}
      </button>
    </div>
  );
}
export function Loading({ cards = false }: { cards?: boolean }) {
  const { t } = useSession();
  return (
    <div
      role="status"
      aria-label={t("common.loading")}
      className={cards ? "card_grid" : "loading_rows"}
    >
      {[0, 1, 2].map((n) => (
        <div key={n} className={`skeleton ${cards ? "card_skeleton" : ""}`} />
      ))}
      <span className="sr_only">{t("common.loading")}</span>
    </div>
  );
}
const policies = [
  "customer_support",
  "terms_of_service",
  "privacy_policy",
  "youth_protection_policy",
  "character_creation_policy",
] as const;
export function Footer() {
  const { t } = useSession();
  const send = useTrack();
  const [policy, setPolicy] = useState<(typeof policies)[number] | null>(null);
  return (
    <footer className="footer">
      <div className="footer_policies">
        {policies.map((key) => (
          <button
            key={key}
            type="button"
            aria-haspopup="dialog"
            onClick={() => {
              send("footer_link_clicked", { item: key });
              setPolicy(key);
            }}
          >
            {t(`character.footer.${key}`)}
          </button>
        ))}
      </div>
      <div className="footer_info">
        <span>{t("character.footer.company")}</span>
        <Link href="/preview">{t("common.preview_settings")}</Link>
      </div>
      {policy && (
        <Modal
          title={t(`character.footer.${policy}`)}
          closeLabel={t("character.footer.policy_close")}
          className="policy_modal"
          onClose={() => {
            send("footer_modal_closed", { item: policy });
            setPolicy(null);
          }}
        >
          <div className="policy_body">
            {t("character.footer.policy_placeholder")}
          </div>
        </Modal>
      )}
    </footer>
  );
}

/** Required consents, before anything else on any screen (ACCOUNT web 2-2-6). */
export function ConsentHost() {
  const { account, accountRedirect } = useSession();
  const pathname = usePathname();
  // An account change on its way to another screen (a withdrawal goes home) opens the modal
  // there, so it shows and is recorded on that screen, not the one being left.
  if (accountRedirect !== null && pathname !== accountRedirect.split("?")[0])
    return null;
  // A new showing (a new required version) starts with nothing checked.
  return account.consent_required ? <Consent /> : null;
}
function Consent() {
  const { t, account, replaceAccount } = useSession();
  const send = useOverlayTrack();
  const consentItems = account.consent_items;
  // Once per showing (TRACKING-PLAN 9-1).
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    send("consent_modal_viewed", {
      items: consentItems.map((item) => item.id),
    });
  }, [consentItems, send]);
  const [checked, setChecked] = useState<string[]>([]);
  // Items whose text is unfolded under them.
  const [shown, setShown] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const all = consentItems.every((item) => checked.includes(item.id));
  const ready = consentItems.every(
    (item) => !item.required || checked.includes(item.id),
  );
  const toggle = (id: string) => {
    send("consent_checked", { item: id, checked: !checked.includes(id) });
    setChecked((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
  };
  async function agree() {
    if (busy || !ready) return;
    send("consent_agree_clicked", {
      items: consentItems
        .filter((item) => checked.includes(item.id))
        .map((item) => item.id),
    });
    setBusy(true);
    setError("");
    try {
      const next = await api("/account/me/consents", accountSchema, {
        method: "POST",
        body: JSON.stringify({
          items: consentItems
            .filter((item) => checked.includes(item.id))
            .map((item) => ({ id: item.id, version: item.version })),
        }),
      });
      replaceAccount(next);
    } catch (failure) {
      // 422 means this build's items differ from the server's: show the failure and keep going.
      send("consent_failed", { code: errorCode(failure) });
      setError("account.consent.failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("account.consent.title")}
      className="consent_modal"
      locked
      onClose={() => {}}
    >
      <p className="muted">{t("account.consent.description")}</p>
      <label className="consent_all">
        <input
          type="checkbox"
          checked={all}
          onChange={() => {
            // One event for the whole row, not one per item (TRACKING-PLAN 9-2).
            send("consent_checked", { item: "all", checked: !all });
            setChecked(all ? [] : consentItems.map((item) => item.id));
          }}
        />
        <span>{t("account.consent.all")}</span>
      </label>
      <ul className="consent_items">
        {consentItems.map((item) => (
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                checked={checked.includes(item.id)}
                onChange={() => toggle(item.id)}
              />
              <span>{t(`account.consent.item.${item.id}`)}</span>
              <small>
                {t(
                  item.required
                    ? "account.consent.required"
                    : "account.consent.optional",
                )}
              </small>
            </label>
            <button
              type="button"
              className="consent_toggle"
              aria-expanded={shown.includes(item.id)}
              aria-controls={`consent_body_${item.id}`}
              aria-label={t(
                shown.includes(item.id)
                  ? "account.consent.hide_item"
                  : "account.consent.view_item",
                { name: t(`account.consent.item.${item.id}`) },
              )}
              onClick={() => {
                send("consent_detail_toggled", {
                  item: item.id,
                  open: !shown.includes(item.id),
                });
                setShown((current) =>
                  current.includes(item.id)
                    ? current.filter((value) => value !== item.id)
                    : [...current, item.id],
                );
              }}
            >
              {t(
                shown.includes(item.id)
                  ? "account.consent.hide"
                  : "account.consent.view",
              )}
            </button>
            {shown.includes(item.id) && (
              <div
                id={`consent_body_${item.id}`}
                className="consent_body"
                role="region"
                aria-label={t("account.consent.body_label", {
                  name: t(`account.consent.item.${item.id}`),
                })}
                tabIndex={0}
              >
                {/* Placeholder until the documents are written (TBD). */}
                <p>{t("account.consent.body_placeholder")}</p>
                {item.document_url && (
                  <a href={item.document_url} target="_blank" rel="noreferrer">
                    {t("account.consent.open_document")}
                  </a>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="inline_error" role="alert">
          {t(error)}
        </p>
      )}
      <button
        className="button primary wide"
        disabled={!ready || busy}
        onClick={() => void agree()}
      >
        {t("account.consent.agree")}
      </button>
    </Modal>
  );
}
/** Gender and birth date once, when an unverified member turns SAFE off (ACCOUNT web 2-2-7). */
export function AdultVerificationHost() {
  const { adultVerification } = useSession();
  if (!adultVerification) return null;
  return <AdultVerification request={adultVerification} />;
}
function AdultVerification({ request }: { request: AdultVerificationRequest }) {
  const { t, replaceAccount, closeAdultVerification } = useSession();
  const send = useOverlayTrack();
  const queryClient = useQueryClient();
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    send("adult_verification_viewed");
  }, [send]);
  const [gender, setGender] = useState<"male" | "female" | "">("");
  const [birthDate, setBirthDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState("");
  const today = regionToday();
  // Closed without passing (TRACKING-PLAN 9-9); passing closes it through submit.
  const close = (method: CloseReason | "cancel") => {
    if (busy) return;
    send("adult_verification_closed", { method, rejected });
    closeAdultVerification();
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || rejected || !gender || !birthDate) return;
    send("adult_verification_submit_clicked");
    setBusy(true);
    setError("");
    let next;
    try {
      next = await api("/account/me/adult_verification", accountSchema, {
        method: "POST",
        body: JSON.stringify({ gender, birth_date: birthDate }),
      });
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        failure.code === "adult_verification_submitted"
      ) {
        // Already submitted elsewhere: take the stored result, reread what SAFE filtered
        // and close. Stays busy until then so a second click sends nothing.
        await refreshSession().catch(() => undefined);
        await queryClient.invalidateQueries();
        closeAdultVerification();
        return;
      }
      setBusy(false);
      send("adult_verification_failed", { code: errorCode(failure) });
      setError(
        failure instanceof ApiError && failure.status === 403
          ? "character.adult_mode_unavailable"
          : "account.adult.failed",
      );
      return;
    }
    setBusy(false);
    if (next.adult_verified) {
      closeAdultVerification();
      request.onPassed(next);
      return;
    }
    // Rejected: keep the modal with the reason; only closing is left.
    setRejected(true);
    replaceAccount(next);
  }
  const locked = busy || rejected;
  return (
    <Modal
      title={t("account.adult.title")}
      className="adult_modal"
      closeLabel={t("account.adult.close")}
      onClose={close}
    >
      <form onSubmit={(event) => void submit(event)}>
        {ageConfig.rating_mark_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="rating_mark"
            src={ageConfig.rating_mark_url}
            alt={t("account.adult.rating_mark_alt")}
          />
        )}
        <p className="adult_notice">{t(ageConfig.notice_key)}</p>
        <fieldset className="gender_choice" disabled={locked}>
          <legend>{t("account.adult.gender")}</legend>
          {(["male", "female"] as const).map((value, index) => (
            <label key={value}>
              <input
                type="radio"
                name="gender"
                value={value}
                checked={gender === value}
                autoFocus={index === 0}
                onChange={() => setGender(value)}
              />
              <span>{t(`account.adult.gender_${value}`)}</span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          {t("account.adult.birth_date")}
          <input
            type="date"
            min="1900-01-01"
            max={today}
            value={birthDate}
            disabled={locked}
            onChange={(event) => setBirthDate(event.target.value)}
          />
        </label>
        <p className="field_help">{t("account.adult.irreversible")}</p>
        {(rejected || error) && (
          <p className="inline_error" role="alert">
            {t(rejected ? "account.adult.rejected" : error)}
          </p>
        )}
        <div className="modal_actions">
          <button
            type="button"
            className="button"
            onClick={() => close("cancel")}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={locked || !gender || !birthDate}
          >
            {t("account.adult.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
