"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, readStream, request } from "@/lib/api";
import { ApiError, roomSchema, type Message, type Room } from "@/lib/contracts";
import { errorCode, track } from "@/lib/analytics";
import { errorMessageKey } from "@/lib/errors";
import { useSession } from "./providers";
import { ErrorState, Icon, Loading, Modal, ProfileMenu } from "./ui";
import { DeleteChatModal, RecentChats, type RecentChat } from "./recent-chats";

type Pending = { client_message_id: string; content: string };
function readPending(key: string): Pending | null {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(key) ?? "null",
    ) as Pending | null;
    if (saved?.client_message_id && typeof saved.content === "string")
      return saved;
  } catch {
    sessionStorage.removeItem(key);
  }
  return null;
}
/** 1-based order of a user message among this room's saved user messages (TRACKING-PLAN 5-4). */
function turnIndex(room: Room | undefined, clientMessageId: string) {
  const users = (room?.messages ?? []).filter(
    (message) => message.role === "user" && message.turn_status !== "failed",
  );
  const found = users.findIndex(
    (message) => message.client_message_id === clientMessageId,
  );
  return found === -1 ? users.length + 1 : found + 1;
}
export function Chat({ roomId }: { roomId: string }) {
  const { account, locale, t, notice, openLogin } = useSession();
  const query = useQueryClient();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecentChat | null>(null);
  const storageKey = `dopia:draft:${account.account_id}:${roomId}`;
  const pendingKey = `${storageKey}:pending`;
  // Chat is keyed by room and sits under a subtree keyed by account, so these keys never
  // change for one instance: read what this tab saved once, at mount.
  const [saved] = useState(() => ({
    draft: sessionStorage.getItem(storageKey) ?? "",
    pending: readPending(pendingKey),
  }));
  const [draft, setDraft] = useState(saved.draft);
  const [pending, setPending] = useState<Pending | null>(saved.pending);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const pendingRef = useRef<Pending | null>(saved.pending);
  const draftRef = useRef(saved.draft);
  const sending = useRef(saved.pending !== null);
  const disposed = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const follow = useRef(true);
  const firstScroll = useRef(true);
  const restored = useRef(saved.pending !== null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scene = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const viewed = useRef(false);
  const redirected = useRef(false);
  const retrying = useRef(false);
  const key = ["room", account.account_id, roomId, locale];
  const result = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/chats/${roomId}`, roomSchema, { signal }),
    refetchInterval: (query) =>
      query.state.data?.generating || pendingRef.current ? 600 : false,
  });
  /** Sent once however the room turns out gone: first read, a later refetch, or a send. */
  function recordRedirect(code: string) {
    if (redirected.current) return;
    redirected.current = true;
    track("chat_room_redirected", "chat_room", { room_id: roomId, code });
  }
  function updateDraft(value: string) {
    draftRef.current = value;
    setDraft(value);
    sessionStorage.setItem(storageKey, value);
  }
  function finishPending(
    failed: boolean,
    message = "chat.failed",
    code = "unknown",
  ) {
    const current = pendingRef.current;
    if (!current) return;
    // Runs once per send: pendingRef is cleared right below.
    if (failed)
      track("message_reply_failed", "chat_room", { room_id: roomId, code });
    else
      track("message_reply_completed", "chat_room", {
        room_id: roomId,
        character_id: result.data?.character.id ?? null,
        turn_index: turnIndex(result.data, current.client_message_id),
      });
    pendingRef.current = null;
    restored.current = false;
    sending.current = false;
    setPending(null);
    setPartial("");
    sessionStorage.removeItem(pendingKey);
    if (failed) {
      updateDraft(
        current.content + (draftRef.current ? `\n${draftRef.current}` : ""),
      );
      setError(message);
    }
    void query.invalidateQueries({ queryKey: ["recent"] });
  }
  useEffect(() => {
    disposed.current = false;
    firstScroll.current = true;
    return () => {
      disposed.current = true;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const current = pendingRef.current;
    const user = result.data?.messages.find(
      (value) =>
        value.client_message_id === current?.client_message_id &&
        value.role === "user",
    );
    if (user?.turn_status === "failed")
      finishPending(
        true,
        errorMessageKey(new ApiError(user.error_code ?? "", 0), "chat.failed"),
        user.error_code ?? "unknown",
      );
    else if (user?.turn_status === "completed") finishPending(false);
    else if (result.data && current && restored.current && !user)
      finishPending(true);
    // Pending is reconciled with persisted turn state, independently of the live stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.data]);
  useEffect(() => {
    // The first settled read of this room (TRACKING-PLAN 5-1, 5-2); later refetches are not views.
    if (viewed.current || result.isPending) return;
    viewed.current = true;
    // A room that is gone or not this account's is recorded as a redirect below, not a view.
    if (!(
      result.error instanceof ApiError &&
      [401, 403, 404].includes(result.error.status)
    ))
      track("chat_room_viewed", "chat_room", {
        room_id: roomId,
        character_id: result.data?.character.id ?? null,
        load_result: result.isError ? "failed" : "loaded",
      });
  }, [result.isPending, result.isError, result.error, result.data, roomId]);
  useEffect(() => {
    // A manual retry of a failed room read settles here (TRACKING-PLAN 3-19).
    if (!retrying.current || result.isFetching) return;
    retrying.current = false;
    track("retry_finished", "chat_room", {
      target: "chat_room",
      result: result.isError ? "failed" : "loaded",
    });
  }, [result.isFetching, result.isError]);
  useEffect(() => {
    if (
      result.error instanceof ApiError &&
      [401, 403, 404].includes(result.error.status)
    ) {
      if (result.error.status !== 401) recordRedirect(result.error.code);
      controller.current?.abort();
      sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(pendingKey);
      notice(t(errorMessageKey(result.error)));
      router.replace("/");
    }
  }, [result.error, router, storageKey, pendingKey, notice, t]);
  useEffect(() => {
    const element = scene.current;
    if (element && result.data && (follow.current || firstScroll.current)) {
      element.scrollTop = element.scrollHeight;
      firstScroll.current = false;
    }
  }, [result.data, partial, pending]);
  async function send(method: "button" | "enter") {
    const content = draftRef.current.trim();
    if (
      !content ||
      content.length > 4000 ||
      sending.current ||
      result.data?.generating ||
      !result.data
    )
      return;
    track("message_send_clicked", "chat_room", {
      room_id: roomId,
      character_id: result.data.character.id,
      method,
      // Characters as people see them: an emoji counts once, not as two UTF-16 units.
      length: Array.from(
        new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(
          content,
        ),
      ).length,
    });
    const current = { client_message_id: crypto.randomUUID(), content };
    pendingRef.current = current;
    restored.current = false;
    sending.current = true;
    setPending(current);
    setPartial("");
    setError("");
    updateDraft("");
    follow.current = true;
    sessionStorage.setItem(pendingKey, JSON.stringify(current));
    const abort = new AbortController();
    controller.current = abort;
    try {
      const response = await request(`/chats/${roomId}/messages`, {
        method: "POST",
        body: JSON.stringify(current),
        signal: abort.signal,
      });
      await readStream(response, (event) => {
        if (
          disposed.current ||
          pendingRef.current?.client_message_id !== current.client_message_id
        )
          return;
        if (event.event === "accepted")
          void query.invalidateQueries({
            queryKey: ["room", account.account_id, roomId],
          });
        else if (event.event === "token")
          setPartial((value) => value + event.data.text);
        else if (event.event === "completed") {
          setPartial(event.data.content);
          void query.invalidateQueries({
            queryKey: ["room", account.account_id, roomId],
          });
        } else if (event.event === "failed") {
          finishPending(
            true,
            errorMessageKey(new ApiError(event.data.code, 0), "chat.failed"),
            event.data.code,
          );
          void query.invalidateQueries({
            queryKey: ["room", account.account_id, roomId],
          });
        }
      });
    } catch (error) {
      if (disposed.current || abort.signal.aborted) return;
      const message = errorMessageKey(error, "chat.failed");
      if (error instanceof ApiError && error.status === 401) {
        // Identity recovery already failed or switched users; do not start
        // another request for the previous account's pending work.
        if (error.code !== "account_changed")
          finishPending(true, message, error.code);
        return;
      }
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        recordRedirect(error.code);
        controller.current?.abort();
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(pendingKey);
        notice(t(message));
        router.replace("/");
        return;
      }
      if (error instanceof ApiError && [409, 422, 429].includes(error.status)) {
        finishPending(true, message, error.code);
        if (error.status === 409)
          void query.invalidateQueries({ queryKey: key });
        return;
      }
      try {
        const saved = await api(`/chats/${roomId}`, roomSchema);
        if (disposed.current) return;
        query.setQueryData(key, saved);
        const user = saved.messages.find(
          (message) =>
            message.client_message_id === current.client_message_id &&
            message.role === "user",
        );
        if (!user || user.turn_status === "failed")
          finishPending(true, message, user?.error_code ?? errorCode(error));
        else if (user.turn_status === "completed") finishPending(false);
        // A generating turn stays locked and is polled until its terminal state.
      } catch {
        if (!disposed.current) finishPending(true, message, errorCode(error));
      }
    }
  }
  function addAction() {
    const input = textarea.current;
    if (!input) return;
    track("action_button_clicked", "chat_room", { room_id: roomId });
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (draftRef.current.length + 2 > 4000) return;
    const next = `${draftRef.current.slice(0, start)}*${draftRef.current.slice(start, end)}*${draftRef.current.slice(end)}`;
    updateDraft(next);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + 1, end + 1);
    });
  }
  function leaveDeletedRoom(target: RecentChat) {
    if (target.room_id !== roomId) {
      const otherKey = `dopia:draft:${account.account_id}:${target.room_id}`;
      sessionStorage.removeItem(otherKey);
      sessionStorage.removeItem(`${otherKey}:pending`);
      return;
    }
    controller.current?.abort();
    sessionStorage.removeItem(storageKey);
    sessionStorage.removeItem(pendingKey);
    router.replace("/");
  }
  const savedMessages =
    result.data?.messages.filter(
      (message) => message.turn_status !== "failed",
    ) ?? [];
  const hasPendingUser = savedMessages.some(
    (message) => message.client_message_id === pending?.client_message_id,
  );
  const hasPendingReply = savedMessages.some(
    (message) =>
      message.client_message_id === pending?.client_message_id &&
      message.role === "assistant",
  );
  const generating = !!pending || !!result.data?.generating;
  return (
    <div className="chat_page">
      <header className="chat_header">
        <button
          className="icon_button"
          aria-label={t("common.menu")}
          aria-expanded={menu}
          onClick={() => setMenu(true)}
        >
          <Icon name="menu" />
        </button>
        <div className="chat_identity">
          {result.data && (
            <>
              <img src={result.data.character.image_url} alt="" />
              <h1>{result.data.character.name}</h1>
            </>
          )}
        </div>
        <div className="header_actions">
          {account.is_guest ? (
            <button
              type="button"
              className="login_link"
              aria-haspopup="dialog"
              onClick={() => openLogin({ returnTo: `/chats/${roomId}` })}
            >
              {t("account.login.button")}
            </button>
          ) : (
            <ProfileMenu />
          )}
        </div>
      </header>
      {menu && (
        <Modal
          drawer
          title={t("common.recent")}
          titleContent={
            <Link className="brand" href="/" onNavigate={() => setMenu(false)}>
              {t("common.brand")}
            </Link>
          }
          onClose={() => setMenu(false)}
        >
          <RecentChats
            currentId={roomId}
            onNavigate={() => setMenu(false)}
            onDelete={(chat) => {
              setMenu(false);
              setDeleteTarget(chat);
            }}
          />
        </Modal>
      )}
      {deleteTarget && (
        <DeleteChatModal
          chat={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={leaveDeletedRoom}
        />
      )}
      <main
        id="main"
        ref={scene}
        className="chat_scene"
        onScroll={(event) => {
          const node = event.currentTarget;
          const bottom =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          follow.current = bottom;
          setAtBottom(bottom);
        }}
      >
        {result.isPending ? (
          <Loading />
        ) : result.isError ? (
          <ErrorState
            error={result.error}
            retry={() => {
              if (retrying.current) return;
              retrying.current = true;
              track("retry_clicked", "chat_room", { target: "chat_room" });
              void result.refetch();
            }}
          />
        ) : (
          <>
            <p className="ai_notice">{t("chat.notice")}</p>
            <div className="conversation">
              <p className="setting_label">
                {t("chat.setting")} <span>〈 1 / 1 〉</span>
              </p>
              <div className="conversation_art">
                <img
                  src={result.data.character.image_url}
                  alt={result.data.character.name}
                />
              </div>
              <div
                className="message_list"
                role="log"
                aria-label={t("chat.messages")}
                aria-live="polite"
                aria-relevant="additions text"
              >
                {savedMessages.map((message) => (
                  <Bubble key={message.id} message={message} locale={locale} />
                ))}
                {pending && !hasPendingUser && (
                  <Bubble
                    message={{
                      id: pending.client_message_id,
                      role: "user",
                      content: pending.content,
                      created_at: new Date().toISOString(),
                      client_message_id: pending.client_message_id,
                      turn_status: "generating",
                      error_code: null,
                    }}
                    locale={locale}
                  />
                )}
                {partial && !hasPendingReply ? (
                  <p className="message assistant streaming" aria-live="off">
                    <MessageText content={partial} />
                  </p>
                ) : generating && !hasPendingReply ? (
                  <div
                    className="typing"
                    role="status"
                    aria-label={t("chat.generating")}
                  >
                    <span />
                    <span />
                    <span />
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </main>
      {!atBottom && (
        <button
          className="scroll_bottom icon_button"
          aria-label={t("chat.bottom")}
          onClick={() => {
            track("scroll_bottom_clicked", "chat_room", { room_id: roomId });
            if (scene.current)
              scene.current.scrollTo({
                top: scene.current.scrollHeight,
                behavior: "smooth",
              });
            follow.current = true;
          }}
        >
          <Icon name="down" />
        </button>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send("button");
        }}
      >
        <textarea
          ref={textarea}
          aria-label={t("chat.input")}
          placeholder={t("chat.placeholder")}
          value={draft}
          maxLength={4000}
          rows={2}
          disabled={!result.data || result.isError}
          onChange={(event) => updateDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !composing.current &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              void send("enter");
            }
          }}
        />
        <div className="composer_tools">
          <button
            className="action_button"
            type="button"
            aria-label={t("chat.action")}
            onClick={addAction}
          >
            *
          </button>
          <span className="composer_count">
            {t("chat.count", {
              count: new Intl.NumberFormat(locale).format(draft.length),
              limit: new Intl.NumberFormat(locale).format(4000),
            })}
          </span>
          <button
            className="send_button"
            type="submit"
            aria-label={t("chat.send")}
            disabled={
              generating ||
              !draft.trim() ||
              draft.length > 4000 ||
              !result.data ||
              result.isError
            }
          >
            <Icon name="send" />
          </button>
        </div>
        {error && (
          <p className="inline_error" role="alert">
            {t(error)}
          </p>
        )}
      </form>
    </div>
  );
}
function MessageText({ content }: { content: string }) {
  return content.split(/(\*[^*]+\*)/g).map((part, index) =>
    part.startsWith("*") && part.endsWith("*") ? (
      <em className="action" key={index}>
        {part.slice(1, -1)}
      </em>
    ) : (
      part
    ),
  );
}
function Bubble({ message, locale }: { message: Message; locale: string }) {
  return (
    <div className={`message_wrap ${message.role}`}>
      <p className={`message ${message.role}`}>
        <MessageText content={message.content} />
      </p>
      <time dateTime={message.created_at}>
        {new Intl.DateTimeFormat(locale, {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(message.created_at))}
      </time>
    </div>
  );
}
