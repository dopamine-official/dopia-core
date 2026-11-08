"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, request } from "@/lib/api";
import { recentSchema, type RecentResponse } from "@/lib/contracts";
import { useSession } from "./providers";
import { errorMessageKey } from "@/lib/errors";
import { ErrorState, Icon, Loading, Modal } from "./ui";
export type RecentChat = RecentResponse["chats"][number];
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
  const result = useQuery({
    queryKey: ["recent", account.account_id, locale],
    queryFn: ({ signal }) => api("/chats/recent", recentSchema, { signal }),
    refetchInterval: (query) => (query.state.status === "error" ? false : 3000),
  });
  if (result.isPending) return <Loading />;
  if (result.isError)
    return (
      <ErrorState error={result.error} retry={() => void result.refetch()} />
    );
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
      {result.data.chats.map((chat) => {
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
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  return (
    <div
      className="recent_menu_wrap"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // Close only this menu, not the drawer dialog around it.
        event.preventDefault();
        event.stopPropagation();
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
        onClick={() => setOpen((value) => !value)}
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
  onClose,
  onDeleted,
}: {
  chat: RecentChat;
  onClose: () => void;
  // Runs after the server confirms the delete, before the recent list refreshes.
  onDeleted?: (chat: RecentChat) => void | Promise<void>;
}) {
  const { t, notice } = useSession();
  const query = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await request(`/chats/${chat.room_id}`, { method: "DELETE" });
      await onDeleted?.(chat);
      await query.invalidateQueries({ queryKey: ["recent"] });
    } catch (error) {
      notice(t(errorMessageKey(error)));
    }
    onClose();
  }
  return (
    <Modal title={t("chat.delete_title")} onClose={onClose}>
      <p className="muted">{t("chat.delete_body")}</p>
      <div className="modal_actions">
        <button className="button" onClick={onClose}>
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
