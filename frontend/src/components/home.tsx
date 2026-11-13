"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { homeSchema, openSchema } from "@/lib/contracts";
import { errorMessageKey } from "@/lib/errors";
import { errorCode, track } from "@/lib/analytics";
import { Screen, useRetry } from "./page";
import { useSession } from "./providers";
import {
  ErrorState,
  Footer,
  Loading,
  Modal,
  SiteHeader,
  useSidebarShortcut,
} from "./ui";
import { DeleteChatModal, RecentChats, type RecentChat } from "./recent-chats";

export function Home() {
  return (
    <Screen page="home">
      <HomeScreen />
    </Screen>
  );
}

type CardSpot = { character_id: string; section_id: string; position: number };

/**
 * Sends `character_card_viewed` the first time half of a card is on screen, once per card
 * for this view of the home screen. Returns the ref to put on each card.
 */
function useCardViews() {
  const seen = useRef(new Set<string>());
  const spots = useRef(new WeakMap<Element, CardSpot>());
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      // A remount (React's dev double mount) starts a new observer.
      observer.current = null;
    },
    [],
  );
  return (spot: CardSpot) => (node: HTMLElement | null) => {
    const id = `${spot.section_id}:${spot.character_id}`;
    if (!node || seen.current.has(id)) return;
    observer.current ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Some browsers report any overlap as intersecting; require half the card.
          if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;
          const found = spots.current.get(entry.target);
          observer.current?.unobserve(entry.target);
          if (!found) continue;
          const key = `${found.section_id}:${found.character_id}`;
          if (seen.current.has(key)) continue;
          seen.current.add(key);
          track("character_card_viewed", "home", found);
        }
      },
      { threshold: 0.5 },
    );
    spots.current.set(node, spot);
    observer.current.observe(node);
    return () => observer.current?.unobserve(node);
  };
}

/** Query on home naming the character whose chat opens once the guest has logged in. */
const CHAT_AFTER_LOGIN = "chat";
// The login hand-over already acted on: home mounts again later with the same one.
let chatOpenedFor: string | null = null;
function HomeScreen() {
  const {
    t,
    account,
    locale,
    notice,
    openLogin,
    accountRedirect,
    clearAccountRedirect,
  } = useSession();
  const router = useRouter();
  const query = useQueryClient();
  const [sidebar, setSidebar] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecentChat | null>(null);
  const openingRef = useRef<AbortController | null>(null);
  const result = useQuery({
    queryKey: ["home", account.account_id, account.adult_mode, locale],
    queryFn: ({ signal }) => api("/home", homeSchema, { signal }),
  });
  const watchCard = useCardViews();
  const retry = useRetry("home_list", () => result.refetch());
  const viewed = useRef(false);
  useEffect(() => {
    // Once per showing of the home screen, with how its first read turned out.
    if (viewed.current || result.isPending) return;
    viewed.current = true;
    track("home_viewed", "home", {
      load_result: result.isError
        ? "failed"
        : result.data.sections.length
          ? "loaded"
          : "empty",
    });
  }, [result.isPending, result.isError, result.data]);
  const sidebarOpen = mobile ? mobileOpen : sidebar;
  /** A change the visitor asked for: the menu button, the shortcut, or the drawer's close. */
  function toggleSidebar(open: boolean) {
    track("sidebar_toggled", "home", { open });
    if (mobile) setMobileOpen(open);
    else setSidebar(open);
  }
  useEffect(() => () => openingRef.current?.abort(), []);
  function cancelOpening() {
    openingRef.current?.abort();
    openingRef.current = null;
    setOpening(null);
  }
  useEffect(() => {
    const media = window.matchMedia("(max-width: 650px)");
    const update = () => {
      setMobile(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useSidebarShortcut(() => toggleSidebar(!sidebarOpen));
  async function open(characterId: string, source: "card") {
    // Chat is for members: a guest logs in first, and the chat they chose opens right after
    // (CHARACTER web 2-2).
    if (account.is_guest) {
      openLogin({
        trigger: "chat_open",
        returnTo: `/?${CHAT_AFTER_LOGIN}=${encodeURIComponent(characterId)}&source=${source}`,
      });
      return;
    }
    if (openingRef.current) return;
    const controller = new AbortController();
    openingRef.current = controller;
    setOpening(characterId);
    try {
      const result = await api("/chats/open", openSchema, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ character_id: characterId }),
      });
      if (controller.signal.aborted) return;
      await query.invalidateQueries({ queryKey: ["recent"] });
      if (controller.signal.aborted) return;
      router.push(`/chats/${result.room_id}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      track("chat_open_failed", "home", {
        source,
        character_id: characterId,
        code: errorCode(error),
      });
      notice(t(errorMessageKey(error, "character.open_failed")));
      openingRef.current = null;
      setOpening(null);
    }
  }
  // Back from a login started by a guest's card: open the chat they chose, once.
  useEffect(() => {
    if (account.is_guest) {
      // A new visitor on this tab: their own login may name the same character again.
      chatOpenedFor = null;
      return;
    }
    // The in-page login hands over its target before the address catches up; a provider
    // round trip arrives with it in the address.
    const target = accountRedirect?.startsWith("/?")
      ? accountRedirect.slice(1)
      : window.location.search;
    const params = new URLSearchParams(target);
    const characterId = params.get(CHAT_AFTER_LOGIN);
    if (!characterId || target === chatOpenedFor) return;
    chatOpenedFor = target;
    const here = new URLSearchParams(window.location.search);
    here.delete(CHAT_AFTER_LOGIN);
    here.delete("source");
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (here.size ? `?${here}` : ""),
    );
    // After this render: opening shows its progress state.
    void Promise.resolve().then(() => {
      // Read: a later guest redirect (session expiry) must not land here again.
      if (accountRedirect?.startsWith("/?")) clearAccountRedirect();
      return open(characterId, "card");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per arrival
  }, [account.is_guest, accountRedirect]);
  return (
    <div className={`home_page ${sidebar ? "" : "sidebar_closed"}`}>
      <SiteHeader
        safe
        menu={{
          open: sidebarOpen,
          toggle: () => toggleSidebar(!sidebarOpen),
        }}
      />
      <aside
        className={`home_sidebar ${sidebar ? "" : "hidden"}`}
        aria-label={t("common.recent")}
      >
        <h2>{t("common.recent")}</h2>
        <RecentChats onNavigate={cancelOpening} onDelete={setDeleteTarget} />
      </aside>
      {mobileOpen && (
        <Modal
          drawer
          title={t("common.recent")}
          onClose={() => toggleSidebar(false)}
        >
          <RecentChats
            onNavigate={() => {
              cancelOpening();
              setMobileOpen(false);
            }}
            onDelete={(chat) => {
              setMobileOpen(false);
              setDeleteTarget(chat);
            }}
          />
        </Modal>
      )}
      {deleteTarget && (
        <DeleteChatModal
          chat={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      <main id="main" className="home_main">
        {result.isPending ? (
          <>
            <div className="hero skeleton" />
            <Loading cards />
          </>
        ) : result.isError ? (
          <ErrorState error={result.error} retry={retry} />
        ) : (
          <>
            {result.data.banner && <Banner banner={result.data.banner} />}
            {result.data.sections.length ? (
              result.data.sections.map((section) => (
                <section key={section.id}>
                  <div className="section_heading">
                    <h1>{section.name}</h1>
                    <span>
                      {new Intl.NumberFormat(locale).format(
                        section.characters.length,
                      )}
                    </span>
                  </div>
                  <div className="card_grid">
                    {section.characters.map((character, index) => (
                      <article
                        className="character_card"
                        key={character.id}
                        ref={watchCard({
                          character_id: character.id,
                          section_id: section.id,
                          position: index + 1,
                        })}
                      >
                        <button
                          className="card_link"
                          aria-label={t("character.start", {
                            name: character.name,
                          })}
                          disabled={!!opening}
                          onClick={() => {
                            if (openingRef.current) return;
                            track("character_card_clicked", "home", {
                              character_id: character.id,
                              section_id: section.id,
                              position: index + 1,
                            });
                            void open(character.id, "card");
                          }}
                        >
                          <div className={`card_art art_${index}`}>
                            <img
                              src={character.image_url}
                              alt=""
                              loading="lazy"
                            />
                            {character.image_url.includes("mock_gray") && (
                              <span
                                className="character_initial"
                                aria-hidden="true"
                              >
                                {character.name[0]}
                              </span>
                            )}
                            <span className="card_open" aria-hidden="true">
                              ↗
                            </span>
                          </div>
                          <h2>{character.name}</h2>
                          <p>{character.tagline}</p>
                          <span className="creator">
                            @{character.creator_name}
                          </span>
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <div className="empty_state">
                <p>{t("character.empty")}</p>
              </div>
            )}
          </>
        )}
        {opening && (
          <p className="sr_only" role="status">
            {t("character.opening")}
          </p>
        )}
        <Footer />
      </main>
    </div>
  );
}

/**
 * The home banner: a picture, and a link only when the operator gave one (CHARACTER web 2-2).
 * It never opens a chat.
 */
function Banner({
  banner,
}: {
  banner: { id: string; image_url: string; link_url: string | null };
}) {
  const { t } = useSession();
  const picture = <img src={banner.image_url} alt="" />;
  if (!banner.link_url) {
    return (
      <div className="hero" role="img" aria-label={t("character.banner")}>
        {picture}
      </div>
    );
  }
  const clicked = () =>
    track("banner_clicked", "home", { banner_id: banner.id });
  // A path inside the service stays in this tab; any other address opens a new one.
  if (banner.link_url.startsWith("/")) {
    return (
      <Link
        className="hero"
        href={banner.link_url}
        aria-label={t("character.banner")}
        onClick={clicked}
      >
        {picture}
      </Link>
    );
  }
  return (
    <a
      className="hero"
      href={banner.link_url}
      aria-label={t("character.banner")}
      target="_blank"
      rel="noopener noreferrer"
      onClick={clicked}
    >
      {picture}
    </a>
  );
}
