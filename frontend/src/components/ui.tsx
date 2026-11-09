"use client";
import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { localeNames, supportedLocales, type Locale } from "@/i18n";
import { api } from "@/lib/api";
import { accountSchema } from "@/lib/contracts";
import { errorMessageKey } from "@/lib/errors";
import { useSession } from "./providers";
import { useTrack } from "./page";

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
        {safe && <SafeToggle onLogin={() => openLogin()} />}
        {account.is_guest ? (
          <button
            type="button"
            className="login_link"
            aria-haspopup="dialog"
            onClick={() => {
              send("login_link_clicked");
              openLogin();
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
export function LoginHost() {
  const { t, login, closeLogin } = useSession();
  if (!login) return null;
  return (
    <Modal
      title={t("account.login.title")}
      className="login_modal"
      onClose={closeLogin}
    >
      <p className="muted">{t("account.login.description")}</p>
      <LoginOptions returnTo={login.returnTo} initialError={login.error} />
    </Modal>
  );
}
export function LoginOptions({
  returnTo,
  initialError = "",
}: {
  returnTo: string;
  initialError?: string;
}) {
  const { t, changeAccount } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(initialError);
  async function signIn(provider: "google" | "apple") {
    if (busy) return;
    setBusy(provider);
    setError("");
    if (process.env.NEXT_PUBLIC_LOGIN === "oauth") {
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
    } catch (error) {
      setBusy(null);
      setError(errorMessageKey(error, "account.login.failed"));
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
        <button
          className="button provider apple"
          disabled={!!busy}
          onClick={() => void signIn("apple")}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.1 12.3c0-2 1.6-3 1.7-3.1-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.4.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.1 9 .7 1.1 1.6 2.2 2.7 2.1 1.1 0 1.5-.7 2.9-.7s1.8.7 3 .7 2-1 2.7-2.1c.8-1.2 1.2-2.4 1.2-2.5-.1 0-2.1-.8-2.1-3.9ZM14.9 6.1c.6-.8 1.1-1.8 1-2.9-1 .1-2.1.7-2.8 1.4-.6.7-1.2 1.8-1 2.8 1 .1 2.1-.5 2.8-1.3Z" />
          </svg>
          {t("account.login.apple")}
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
  "profile" | "charge" | "my_characters" | "create_character";
// PostHog flag `character_creation_enabled` is not wired yet; the spec's default (and unreadable) value is false.
const characterCreationEnabled = false;
export function ProfileMenu() {
  const { t, account } = useSession();
  const send = useTrack();
  const [open, setOpen] = useState(false);
  const [charge, setCharge] = useState(false);
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
  const { account, changeAccount, t, notice } = useSession();
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
        if (!account.adult_verified) {
          finish("verification_required");
          notice(t("character.adult_verification_required"));
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
export function Modal({
  title,
  titleContent,
  children,
  onClose,
  drawer = false,
  closeLabel,
  className,
}: {
  title: string;
  titleContent?: ReactNode;
  children: ReactNode;
  onClose: (reason: CloseReason) => void;
  drawer?: boolean;
  closeLabel?: string;
  className?: string;
}) {
  const { t } = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement;
    dialog.showModal();
    if (drawer) closeButton.current?.focus();
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
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
        close.current("escape");
      }}
      onClick={(e) => {
        // A click outside closes a modal; the sidebar drawer stays open until closed on purpose.
        if (!drawer && e.target === e.currentTarget) {
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
        <button
          ref={closeButton}
          className="icon_button"
          onClick={() => onClose("button")}
          aria-label={closeLabel ?? t("common.close")}
        >
          <Icon name="close" />
        </button>
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
