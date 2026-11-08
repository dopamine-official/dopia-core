"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { refreshSession, safeReturnTo, setApiContext, subscribeSession } from "@/lib/api";
import { type Account } from "@/lib/contracts";
import { defaultLocale, resolveLocale, text, type Locale } from "@/i18n";
import { messages } from "@/lib/translations";
import { errorMessageKey } from "@/lib/errors";
import posthog from "posthog-js";

const posthogConfigured = Boolean(
  process.env.NEXT_PUBLIC_POSTHOG_KEY && process.env.NEXT_PUBLIC_POSTHOG_HOST,
);

type Session = {
  account: Account;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  changeAccount: (account: Account, redirectTo?: string) => void;
  accountRedirect: string | null;
  login: LoginRequest | null;
  openLogin: (request?: { returnTo?: string; error?: string }) => void;
  closeLogin: () => void;
  notice: (message: string) => void;
};
export type LoginRequest = { returnTo: string; error: string };
const Context = createContext<Session | null>(null);
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("Session unavailable");
  return value;
}
export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // Keep the navigation intent outside the subtree keyed by account ID.
  const [accountRedirect, setAccountRedirect] = useState<string | null>(null);
  // The login modal replaces the old /login page and can be opened from any screen.
  const [login, setLogin] = useState<LoginRequest | null>(null);
  const openLogin = useCallback(
    (request: { returnTo?: string; error?: string } = {}) =>
      setLogin({
        returnTo: safeReturnTo(
          request.returnTo ?? window.location.pathname + window.location.search,
        ),
        error: request.error ?? "",
      }),
    [],
  );
  const closeLogin = useCallback(() => setLogin(null), []);
  useEffect(() => {
    if (pathname === accountRedirect) setAccountRedirect(null);
  }, [pathname, accountRedirect]);
  const [query] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false, // The transport retries eligible reads once.
            staleTime: 10_000,
            refetchOnWindowFocus: true,
          },
          mutations: { retry: false },
        },
      }),
  );
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);
  const [account, setAccount] = useState<Account | null>(null);
  const [failure, setFailure] = useState("");
  const [toast, setToast] = useState("");
  const localeRef = useRef(locale);
  const accountRef = useRef(account);
  const boot = useRef<Promise<void> | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  const applyAccount = useCallback(
    (next: Account) => {
      const previous = accountRef.current;
      const previousId = previous?.account_id;
      const changed = previousId !== next.account_id;

      if (posthogConfigured && changed) {
        if (previous && !previous.is_guest) posthog.reset();
        if (!next.is_guest) posthog.identify(next.account_id);
      }

      accountRef.current = next;
      setApiContext(localeRef.current, next.account_id);
      setAccount(next);
      if (changed) query.clear();
      // Initial page loads must preserve this account's saved drafts and turns.
      if (changed && previousId) {
        for (const key of Object.keys(sessionStorage))
          if (key.startsWith("dopia:draft:"))
            sessionStorage.removeItem(key);
      }
    },
    [query],
  );
  const changeAccount = useCallback(
    (next: Account, redirectTo?: string) => {
      const sameAccount = accountRef.current?.account_id === next.account_id;
      setAccountRedirect(redirectTo ?? null);
      setLogin(null);
      applyAccount(next);
      if (sameAccount) void query.invalidateQueries();
      channel.current?.postMessage({ type: "account" });
      if (redirectTo) router.replace(redirectTo);
    },
    [applyAccount, query, router],
  );
  const initialize = useCallback(() => {
    if (boot.current) return boot.current;
    setFailure("");
    boot.current = (async () => {
      // A saved choice wins; first visits follow the browser language.
      const saved = resolveLocale(
        localStorage.getItem("dopia:locale") ??
          navigator.languages?.[0] ??
          navigator.language,
      );
      localeRef.current = saved;
      setLocaleState(saved);
      setApiContext(saved, accountRef.current?.account_id);
      // NEXT_PUBLIC_API_MODE=server talks to chat-server through /api/v1; otherwise
      // the in-page mock transport answers.
      if (process.env.NEXT_PUBLIC_API_MODE !== "server") {
        const { startMockApi } = await import("@/mocks/browser");
        await startMockApi();
      }
      await refreshSession();
    })()
      .catch((error) => setFailure(errorMessageKey(error, "common.load_failed")))
      .finally(() => {
        boot.current = null;
      });
    return boot.current;
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeSession(applyAccount);
    void initialize();
    const broadcast = new BroadcastChannel("dopia-preview");
    channel.current = broadcast;
    broadcast.onmessage = () => {
      void refreshSession().catch((error) => {
        notify(text(messages[localeRef.current], errorMessageKey(error, "common.load_failed")));
      });
    };
    return () => {
      unsubscribe();
      broadcast.close();
      channel.current = null;
    };
  }, [applyAccount, initialize, notify]);
  const ready = !!account;
  useEffect(() => {
    // `?login=1` (plus optional `return_to` and `error`) opens the login modal on arrival,
    // e.g. after a redirect for a members-only page or a failed provider round trip.
    if (!ready) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("login") !== "1") return;
    const target = params.get("return_to");
    const error = params.get("error") === "login_failed" ? "account.login.failed" : "";
    for (const key of ["login", "return_to", "error"]) params.delete(key);
    const here = pathname + (params.size ? `?${params}` : "");
    router.replace(here);
    if (accountRef.current?.is_guest === false) {
      if (target) router.replace(safeReturnTo(target));
      return;
    }
    setLogin({ returnTo: safeReturnTo(target ?? here), error });
  }, [ready, pathname, router]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = text(messages[locale], "common.brand");
  }, [locale]);
  function setLocale(next: Locale) {
    const resolved = resolveLocale(next);
    localStorage.setItem("dopia:locale", resolved);
    localeRef.current = resolved;
    setApiContext(resolved, accountRef.current?.account_id);
    setLocaleState(resolved);
  }
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      text(messages[locale], key, params),
    [locale],
  );
  return (
    <QueryClientProvider client={query}>
      {failure ? (
        <main className="bootstrap_state">
          <p role="alert">{t(failure)}</p>
          <button className="button primary" onClick={() => void initialize()}>
            {t("common.retry")}
          </button>
        </main>
      ) : !account ? (
        <main className="bootstrap_state">
          <span className="loader" />
          <p role="status">{t("common.loading")}</p>
        </main>
      ) : (
        <Context.Provider
          key={account.account_id}
          value={{
            account,
            locale,
            setLocale,
            t,
            changeAccount,
            accountRedirect,
            login,
            openLogin,
            closeLogin,
            notice: notify,
          }}
        >
          <a className="skip_link" href="#main">
            {t("common.skip")}
          </a>
          {children}
        </Context.Provider>
      )}
      <div className={`toast ${toast ? "visible" : ""}`} role="status">
        {toast}
      </div>
    </QueryClientProvider>
  );
}
