"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, request } from "@/lib/api";
import {
  myCharactersSchema,
  openSchema,
  type MyCharacter,
} from "@/lib/contracts";
import { errorCode } from "@/lib/analytics";
import { errorMessageKey } from "@/lib/errors";
import { useCreatorOnly, useSession } from "./providers";
import { Screen, useTrack } from "./page";
import { ErrorState, Loading, Modal, SiteHeader } from "./ui";

/** The creator's own characters, newest change first (CHARACTER web 2-2-6). */
export function MyCharacters() {
  return (
    <Screen page="my_characters">
      <Gate />
    </Screen>
  );
}
function Gate() {
  return useCreatorOnly("/characters/mine") ? <List /> : null;
}
function List() {
  const { t, account, notice } = useSession();
  const send = useTrack();
  const router = useRouter();
  const query = useQueryClient();
  const key = ["my_characters", account.account_id];
  const result = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api("/characters/mine", myCharactersSchema, { signal }),
    // Every entry asks again; what was cached shows until the answer comes (4-3-1).
    refetchOnMount: "always",
  });
  const [target, setTarget] = useState<MyCharacter | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current || result.isPending) return;
    viewed.current = true;
    send("my_characters_viewed", {
      load_result: result.isError
        ? "failed"
        : result.data.characters.length
          ? "loaded"
          : "empty",
      count: result.data?.characters.length ?? 0,
    });
  }, [send, result.isPending, result.isError, result.data]);

  function forget(id: string) {
    query.setQueryData<{ characters: MyCharacter[] }>(key, (now) =>
      now
        ? { characters: now.characters.filter((item) => item.id !== id) }
        : now,
    );
  }
  async function remove(character: MyCharacter) {
    if (deleting) return;
    setDeleting(true);
    try {
      await request(`/characters/${character.id}`, { method: "DELETE" });
      send("character_deleted", {
        result: "succeeded",
        character_id: character.id,
        status: character.status,
      });
      forget(character.id);
    } catch (error) {
      const code = errorCode(error);
      // Already gone: the row goes without a notice (4-1-10).
      if (code === "character_not_found") forget(character.id);
      else {
        send("character_deleted", { result: "failed", code });
        notice(t("character.mine.delete_failed"));
      }
    }
    if (!alive.current) return;
    setDeleting(false);
    setTarget(null);
  }
  async function chat(character: MyCharacter) {
    if (opening) return;
    setOpening(character.id);
    send("my_character_chat_clicked", {
      character_id: character.id,
      status: character.status,
    });
    try {
      const room = await api("/chats/open", openSchema, {
        method: "POST",
        body: JSON.stringify({ character_id: character.id }),
      });
      if (!alive.current) return;
      await query.invalidateQueries({ queryKey: ["recent"] });
      if (alive.current) router.push(`/chats/${room.room_id}`);
    } catch (error) {
      if (!alive.current) return;
      send("chat_open_failed", {
        source: "my_characters",
        character_id: character.id,
        code: errorCode(error),
      });
      notice(t(errorMessageKey(error, "character.open_failed")));
      if (errorCode(error) === "character_not_found") void result.refetch();
      setOpening(null);
    }
  }

  return (
    <div className="mine_page">
      <SiteHeader />
      <main id="main" className="mine_main">
        <div className="mine_head">
          <h1>{t("character.mine.title")}</h1>
          <Link
            className="button primary"
            href="/characters/new"
            onClick={() => send("character_create_clicked")}
          >
            {t("character.mine.create")}
          </Link>
        </div>
        {result.isPending ? (
          <Loading />
        ) : result.isError && !result.data ? (
          <ErrorState
            message={t("character.mine.load_failed")}
            retry={() => void result.refetch()}
          />
        ) : !result.data.characters.length ? (
          <div className="empty_state">
            <p>{t("character.mine.empty")}</p>
            <Link className="button primary" href="/characters/new">
              {t("character.mine.create")}
            </Link>
          </div>
        ) : (
          <ul className="mine_list">
            {result.data.characters.map((character) => (
              <li key={character.id} className="mine_item">
                <div className="mine_thumb">
                  {character.image_url && (
                    <img src={character.image_url} alt="" loading="lazy" />
                  )}
                </div>
                <div className="mine_copy">
                  <strong>
                    {character.name ?? t("character.mine.unnamed")}
                  </strong>
                  <div className="mine_badges">
                    <span className={`mine_badge ${character.status}`}>
                      {t(`character.mine.status.${character.status}`)}
                    </span>
                    {character.revision_status && (
                      <span
                        className={`mine_badge ${character.revision_status}`}
                      >
                        {t(
                          `character.mine.revision.${character.revision_status}`,
                        )}
                      </span>
                    )}
                  </div>
                  {character.rejection_reason && (
                    <p className="mine_reason">{character.rejection_reason}</p>
                  )}
                </div>
                <div className="mine_actions">
                  <Link
                    className="button"
                    href={`/characters/${character.id}/edit`}
                  >
                    {t("character.mine.edit")}
                  </Link>
                  {character.status !== "draft" && (
                    <button
                      type="button"
                      className="button"
                      disabled={opening === character.id}
                      onClick={() => void chat(character)}
                    >
                      {t("character.mine.chat")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button danger"
                    onClick={() => setTarget(character)}
                  >
                    {t("character.mine.delete")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
      {target && (
        <Modal
          title={t("character.mine.delete_confirm_title")}
          onClose={() => {
            if (!deleting) setTarget(null);
          }}
        >
          <p className="muted">{t("character.mine.delete_confirm_body")}</p>
          <div className="modal_actions">
            <button
              className="button"
              disabled={deleting}
              onClick={() => setTarget(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="button danger"
              disabled={deleting}
              onClick={() => void remove(target)}
            >
              {t("character.mine.delete_confirm_button")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
