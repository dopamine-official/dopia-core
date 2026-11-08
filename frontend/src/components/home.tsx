"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { homeSchema, openSchema } from "@/lib/contracts";
import { errorMessageKey } from "@/lib/errors";
import { useSession } from "./providers";
import { ErrorState, Footer, Loading, Modal, SiteHeader } from "./ui";
import { DeleteChatModal, RecentChats, type RecentChat } from "./recent-chats";

export function Home() {
  const { t, account, locale, notice } = useSession();
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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (mobile) setMobileOpen((v) => !v);
        else setSidebar((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mobile]);
  async function open(characterId: string) {
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
      notice(t(errorMessageKey(error, "character.open_failed")));
      openingRef.current = null;
      setOpening(null);
    }
  }
  return (
    <div className={`home_page ${sidebar ? "" : "sidebar_closed"}`}>
      <SiteHeader
        safe
        menu={{
          open: mobile ? mobileOpen : sidebar,
          toggle: () =>
            mobile ? setMobileOpen((v) => !v) : setSidebar((v) => !v),
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
          onClose={() => setMobileOpen(false)}
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
          <ErrorState
            error={result.error}
            retry={() => void result.refetch()}
          />
        ) : (
          <>
            {result.data.banner && (
              <button
                className="hero"
                disabled={!!opening}
                aria-label={t("character.start", {
                  name: result.data.banner.name,
                })}
                onClick={() => void open(result.data.banner!.character_id)}
              >
                <img src={result.data.banner.image_url} alt="" />
                <span className="hero_copy">
                  <span>CHARACTER CHAT</span>
                  <strong>{t("character.tagline")}</strong>
                  <span className="hero_cta">
                    {opening ? t("character.opening") : result.data.banner.name}{" "}
                    <span aria-hidden="true">↗</span>
                  </span>
                </span>
              </button>
            )}
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
                      <article className="character_card" key={character.id}>
                        <button
                          className="card_link"
                          aria-label={t("character.start", {
                            name: character.name,
                          })}
                          disabled={!!opening}
                          onClick={() => void open(character.id)}
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
