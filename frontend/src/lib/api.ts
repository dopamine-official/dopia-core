import { z } from "zod";
import { defaultLocale, regionCode, type Locale } from "@/i18n";
import {
  accountIdentitySchema,
  accountSchema,
  ApiError,
  type Account,
} from "./contracts";
let locale: Locale = defaultLocale;
let identity: string | undefined;
let identityVersion = 0;
let recoveryVersion = 0;
let recovery:
  { identityVersion: number; promise: Promise<Account> } | undefined;
const sessionListeners = new Set<(account: Account) => void>();
export function setApiContext(nextLocale: Locale, accountId?: string) {
  locale = nextLocale;
  if (identity !== accountId) identityVersion++;
  identity = accountId;
}
export function subscribeSession(listener: (account: Account) => void) {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
function assertIdentity(version: number) {
  if (version !== identityVersion) throw new ApiError("account_changed", 401);
}
function requestOptions(
  options: RequestInit,
  accountId = identity,
): RequestInit {
  const headers = new Headers(options.headers);
  headers.set("X-Locale", locale);
  headers.set("X-Region", regionCode);
  if (accountId) headers.set("X-Preview-Account", accountId);
  else headers.delete("X-Preview-Account");
  if (typeof options.body === "string")
    headers.set("Content-Type", "application/json");
  return {
    ...options,
    headers,
    credentials: "same-origin",
  };
}
async function send(
  path: string,
  options: RequestInit,
  retry = { used: false },
): Promise<Response> {
  const version = identityVersion;
  const method = (options.method ?? "GET").toUpperCase();
  const canRetry =
    method === "GET" || (method === "POST" && path === "/account/guest");
  while (true) {
    options.signal?.throwIfAborted();
    assertIdentity(version);
    if (!navigator.onLine) throw new ApiError("offline", 0);
    let response: Response;
    try {
      response = await fetch(`/api/v1${path}`, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      assertIdentity(version);
      if (!(error instanceof TypeError)) throw error;
      if (!canRetry || retry.used) throw new ApiError("network_error", 0);
      retry.used = true;
      continue;
    }
    if (!canRetry || retry.used || response.status < 500) return response;
    retry.used = true;
    await response.body?.cancel();
  }
}
async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiError(
      typeof error?.code === "string" ? error.code : "http_error",
      response.status,
      error?.detail,
    );
  }
  return response;
}
// Identity-only responses must be followed by a profile lookup. This raw lookup
// never starts another recovery, including when it is part of 401 recovery.
export async function readAccount(accountId: string): Promise<Account> {
  const version = identityVersion;
  const response = await checked(
    await send("/account/me", requestOptions({}, accountId)),
  );
  const next = accountSchema.parse(await response.json());
  assertIdentity(version);
  if (next.account_id !== accountId) throw new ApiError("account_changed", 401);
  return next;
}
export function refreshSession(): Promise<Account> {
  const version = identityVersion;
  if (recovery?.identityVersion === version) return recovery.promise;
  const promise = (async () => {
    // Do not attach an obsolete preview identity to guest issuance.
    const response = await checked(
      await send("/account/guest", requestOptions({ method: "POST" }, "")),
    );
    const issued = accountIdentitySchema.parse(await response.json());
    assertIdentity(version);
    const next = await readAccount(issued.account_id);
    assertIdentity(version);
    setApiContext(locale, next.account_id);
    recoveryVersion++;
    for (const listener of sessionListeners) listener(next);
    return next;
  })().finally(() => {
    if (recovery?.promise === promise) recovery = undefined;
  });
  recovery = { identityVersion: version, promise };
  return promise;
}
export async function request(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const version = identityVersion;
  const recovered = recoveryVersion;
  // Keep the original body, client_message_id, headers and signal for the retry.
  const original = requestOptions(options);
  const retry = { used: false };
  let response = await send(path, original, retry);
  assertIdentity(version);
  if (response.status === 401 && path !== "/account/guest") {
    await response.body?.cancel();
    original.signal?.throwIfAborted();
    // A concurrent request may already have completed recovery for this session.
    try {
      if (recovered === recoveryVersion) await refreshSession();
    } catch {
      original.signal?.throwIfAborted();
      assertIdentity(version);
      throw new ApiError("session_recovery_failed", 401);
    }
    original.signal?.throwIfAborted();
    assertIdentity(version);
    response = await send(path, original, retry);
    assertIdentity(version);
  }
  return checked(response);
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: RequestInit,
): Promise<T> {
  const version = identityVersion;
  const response = await request(path, options);
  const value = schema.parse(await response.json());
  assertIdentity(version);
  return value;
}
const streamEvent = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("accepted"),
    data: z.object({ user_message_id: z.string() }),
  }),
  z.object({ event: z.literal("token"), data: z.object({ text: z.string() }) }),
  z.object({
    event: z.literal("completed"),
    data: z.object({ assistant_message_id: z.string(), content: z.string() }),
  }),
  z.object({
    event: z.literal("failed"),
    data: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type StreamEvent = z.infer<typeof streamEvent>;
export async function readStream(
  response: Response,
  onEvent: (value: StreamEvent) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError("empty_stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll(
        "\r\n",
        "\n",
      );
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame
          .split("\n")
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!event || !data) continue;
        const parsed = streamEvent.parse({ event, data: JSON.parse(data) });
        if (terminal) throw new ApiError("invalid_stream");
        onEvent(parsed);
        if (event === "completed" || event === "failed") terminal = true;
      }
    }
    if (!terminal) throw new ApiError("stream_interrupted");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function safeReturnTo(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f]/.test(value)
  )
    return "/";
  try {
    const url = new URL(value, "https://preview.invalid");
    if (
      url.origin !== "https://preview.invalid" ||
      url.pathname === "/login" ||
      (!["/", "/me", "/preview"].includes(url.pathname) &&
        !/^\/chats\/[\da-f-]{36}$/.test(url.pathname))
    )
      return "/";
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}
