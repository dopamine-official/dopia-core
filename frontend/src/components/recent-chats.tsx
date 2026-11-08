"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, request } from "@/lib/api";
import { recentSchema, type RecentResponse } from "@/lib/contracts";
import { useSession } from "./providers";
import { errorMessageKey } from "@/lib/errors";
import { errorCode } from "@/lib/analytics";
import { useRetry, useTrack } from "./page";
import { ErrorState, Icon, Loading, Modal, type CloseReason } from "./ui";
export type RecentChat = RecentResponse["chats"][number];
// Lists whose failure notice is already recorded and not yet replaced by a loaded list.
const failureShown = new Set<string>();
export function RecentChats({
  currentId,
  onNavigate,
  onDelete,
}: {
  currentId?: string;
  onNavigate?: () => void;
  // When set, each item gets a "more" button whose menu offers deletion.
  onDelete?: (chat: RecentChat) => void;
}) {
  const { account, locale, t } = useSession();
  const send = useTrack();
  const key = ["recent", account.account_id, locale];
  const result = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      // Recorded here, once per read, because a screen can show this list twice (the
      // sidebar and the mobile drawer). Only when the failure notice first appears: a
      // later read that fails again, such as the drawer's read on opening, changes
      // nothing on screen.
      const id = JSON.stringify(key);
      try {
        const data = await api("/chats/recent", recentSchema, { signal });
        failureShown.delete(id);
        return data;
      } catch (error) {
        if (!signal.aborted && !failureShown.has(id)) {
          failureShown.add(id);
          send("recent_chats_load_failed");
        }
        throw error;
      }
    },
    refetchInterval: (query) => (query.state.status === "error" ? false : 3000),
  });
  const retry = useRetry("recent_chats", () => result.refetch());
  if (result.isPending) return <Loading />;
  if (result.isError) return <ErrorState error={result.error} retry={retry} />;
  if (!result.data.chats.length)
    return (
      <div className="empty_recent">
        <Icon name="chat" />
        <p>{t("common.no_chats")}</p>
        <span>{t("common.start_chat")}</span>
      </div>
    );
  return (
    <nav className="recent_list" aria-label={t("common.recent")}>
      {result.data.chats.map((chat, index) => {
        const content = (
          <>
            <img src={chat.character.image_url} alt="" />
            <span className="recent_copy">
              <strong>{chat.character.name}</strong>
              <span>{chat.last_message?.replace(/\*/g, "")}</span>
            </span>
          </>
        );
        const item =
          chat.room_id === currentId ? (
            <div
              className="recent_item current"
              aria-current="page"
              key={chat.room_id}
            >
              {content}
            </div>
          ) : (
            <Link
              className="recent_item"
              aria-label={chat.character.name}
              key={chat.room_id}
              href={`/chats/${chat.room_id}`}
              onClick={() =>
                send("recent_chat_clicked", {
                  room_id: chat.room_id,
                  character_id: chat.character.id,
                  position: index + 1,
                })
              }
              onNavigate={onNavigate}
            >
              {content}
            </Link>
          );
        if (!onDelete) return item;
        return (
          <div className="recent_row" key={chat.room_id}>
            {item}
            <RecentMenu chat={chat} onDelete={onDelete} />
          </div>
        );
      })}
    </nav>
  );
}
function RecentMenu({
  chat,
  onDelete,
}: {
  chat: RecentChat;
  onDelete: (chat: RecentChat) => void;
}) {
  const { t } = useSession();
  const send = useTrack();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (wrap.current?.contains(event.target as Node)) return;
      send("recent_chat_menu_closed", {
        room_id: chat.room_id,
        method: "outside",
      });
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open, send, chat.room_id]);
  return (
    <div
      className="recent_menu_wrap"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // Close only this menu, not the drawer dialog around it.
        event.preventDefault();
        event.stopPropagation();
        send("recent_chat_menu_closed", {
          room_id: chat.room_id,
          method: "escape",
        });
        setOpen(false);
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        type="button"
        className="icon_button recent_more"
        aria-label={t("chat.more", { name: chat.character.name })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          send("recent_chat_more_clicked", {
            room_id: chat.room_id,
            character_id: chat.character.id,
            open: !open,
          });
          setOpen(!open);
        }}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="recent_menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="danger"
            autoFocus
            onClick={() => {
              send("chat_delete_clicked", {
                room_id: chat.room_id,
                character_id: chat.character.id,
              });
              setOpen(false);
              onDelete(chat);
            }}
          >
            <Icon name="trash" />
            {t("chat.menu_delete")}
          </button>
        </div>
      )}
    </div>
  );
}
export function DeleteChatModal({
  chat,
  currentId,
  onClose,
  onDeleted,
}: {
  chat: RecentChat;
  // The room on screen, if any, for `is_current_room`.
  currentId?: string;
  onClose: () => void;
  // Runs after the server confirms the delete, before the recent list refreshes.
  onDeleted?: (chat: RecentChat) => void | Promise<void>;
}) {
  const { t, notice } = useSession();
  const send = useTrack();
  const query = useQueryClient();
  const [busy, setBusy] = useState(false);
  const room = { room_id: chat.room_id };
  async function remove() {
    if (busy) return;
    setBusy(true);
    send("chat_delete_confirmed", { ...room, character_id: chat.character.id });
    try {
      await request(`/chats/${chat.room_id}`, { method: "DELETE" });
    } catch (error) {
      send("chat_delete_failed", { ...room, code: errorCode(error) });
      notice(t(errorMessageKey(error)));
      onClose();
      return;
    }
    send("chat_deleted", {
      ...room,
      character_id: chat.character.id,
      is_current_room: chat.room_id === currentId,
    });
    try {
      await onDeleted?.(chat);
      await query.invalidateQueries({ queryKey: ["recent"] });
    } catch (error) {
      notice(t(errorMessageKey(error)));
    }
    onClose();
  }
  function cancel(method: "cancel" | "outside" | "escape") {
    // Once the delete is sent, closing the modal no longer cancels it.
    if (!busy) send("chat_delete_cancelled", { ...room, method });
    onClose();
  }
  const methods: Record<CloseReason, "cancel" | "outside" | "escape"> = {
    button: "cancel",
    outside: "outside",
    escape: "escape",
  };
  return (
    <Modal
      title={t("chat.delete_title")}
      onClose={(reason) => cancel(methods[reason])}
    >
      <p className="muted">{t("chat.delete_body")}</p>
      <div className="modal_actions">
        <button className="button" onClick={() => cancel("cancel")}>
          {t("common.cancel")}
        </button>
        <button
          className="button danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          {t("chat.delete")}
        </button>
      </div>
    </Modal>
  );
}
