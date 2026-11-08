"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { api, readStream, request } from "@/lib/api";
import { ApiError, roomSchema, type Message } from "@/lib/contracts";
import { errorMessageKey } from "@/lib/errors";
import { useSession } from "./providers";
import { ErrorState, Icon, Loading, Modal, ProfileMenu } from "./ui";
import { DeleteChatModal, RecentChats, type RecentChat } from "./recent-chats";

type Pending = { client_message_id: string; content: string };
export function Chat({ roomId }: { roomId: string }) {
  const { account, locale, t, notice, openLogin } = useSession();
  const query = useQueryClient();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecentChat | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const pendingRef = useRef<Pending | null>(null);
  const draftRef = useRef("");
  const sending = useRef(false);
  const disposed = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const follow = useRef(true);
  const firstScroll = useRef(true);
  const restored = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scene = useRef<HTMLElement>(null);
  const composing = useRef(false);
  const storageKey = `dopia:draft:${account.account_id}:${roomId}`;
  const pendingKey = `${storageKey}:pending`;
  const key = ["room", account.account_id, roomId, locale];
  const result = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/chats/${roomId}`, roomSchema, { signal }),
    refetchInterval: (query) =>
      query.state.data?.generating || pendingRef.current ? 600 : false,
  });
  function updateDraft(value: string) {
    draftRef.current = value;
    setDraft(value);
    sessionStorage.setItem(storageKey, value);
  }
  function finishPending(failed: boolean, message = "chat.failed") {
    const current = pendingRef.current;
    if (!current) return;
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
    const value = sessionStorage.getItem(storageKey) ?? "";
    draftRef.current = value;
    setDraft(value);
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(pendingKey) ?? "null",
      ) as Pending | null;
      if (saved?.client_message_id && typeof saved.content === "string") {
        pendingRef.current = saved;
        restored.current = true;
        sending.current = true;
        setPending(saved);
      }
    } catch {
      sessionStorage.removeItem(pendingKey);
    }
    return () => {
      disposed.current = true;
      controller.current?.abort();
    };
  }, [storageKey, pendingKey]);
  useEffect(() => {
    const current = pendingRef.current;
    const user = result.data?.messages.find(
      (value) =>
        value.client_message_id === current?.client_message_id &&
        value.role === "user",
    );
    if (user?.turn_status === "failed")
      finishPending(true, errorMessageKey(new ApiError(user.error_code ?? "", 0), "chat.failed"));
    else if (user?.turn_status === "completed") finishPending(false);
    else if (result.data && current && restored.current && !user)
      finishPending(true);
    // Pending is reconciled with persisted turn state, independently of the live stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.data]);
  useEffect(() => {
    if (
      result.error instanceof ApiError &&
      [401, 403, 404].includes(result.error.status)
    ) {
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
  async function send() {
    const content = draftRef.current.trim();
    if (
      !content ||
      content.length > 4000 ||
      sending.current ||
      result.data?.generating ||
      !result.data
    )
      return;
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
      let accepted = false;
      await readStream(response, (event) => {
        if (
          disposed.current ||
          pendingRef.current?.client_message_id !== current.client_message_id
        )
          return;
        if (event.event === "accepted") {
          if (!accepted) {
            accepted = true;
            posthog.capture("chat_message_sent", {
              message_length: content.length,
            });
          }
          void query.invalidateQueries({
            queryKey: ["room", account.account_id, roomId],
          });
        }
        else if (event.event === "token")
          setPartial((value) => value + event.data.text);
        else if (event.event === "completed") {
          setPartial(event.data.content);
          void query.invalidateQueries({
            queryKey: ["room", account.account_id, roomId],
          });
        } else if (event.event === "failed") {
          finishPending(true, errorMessageKey(new ApiError(event.data.code, 0), "chat.failed"));
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
        if (error.code !== "account_changed") finishPending(true, message);
        return;
      }
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        controller.current?.abort();
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(pendingKey);
        notice(t(message));
        router.replace("/");
        return;
      }
      if (error instanceof ApiError && [409, 422, 429].includes(error.status)) {
        finishPending(true, message);
        if (error.status === 409) void query.invalidateQueries({ queryKey: key });
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
        if (!user || user.turn_status === "failed") finishPending(true, message);
        else if (user.turn_status === "completed") finishPending(false);
        // A generating turn stays locked and is polled until its terminal state.
      } catch {
        if (!disposed.current) finishPending(true, message);
      }
    }
  }
  function addAction() {
    const input = textarea.current;
    if (!input) return;
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
          <ErrorState error={result.error} retry={() => void result.refetch()} />
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
          void send();
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
              void send();
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
