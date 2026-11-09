import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  readAccount,
  refreshSession,
  request,
  setApiContext,
  subscribeSession,
} from "@/lib/api";
import { accountSchema, type Account } from "@/lib/contracts";

const current: Account = {
  account_id: "guest-1",
  is_guest: true,
  nickname: null,
  photo_url: null,
  adult_mode: false,
  adult_verified: false,
  adult_verification_rejected: false,
  consent_required: false,
};
const fetchMock = vi.fn<typeof fetch>();
const updated = vi.fn<(account: Account) => void>();
let unsubscribe: () => void;
const json = (value: unknown, status = 200) => Response.json(value, { status });
const unauthorized = () => json({ code: "unauthorized" }, 401);
const calls = (path: string) =>
  fetchMock.mock.calls.filter(([url]) => url === `/api/v1${path}`);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function recover(url: RequestInfo | URL, next: Account = current) {
  if (url === "/api/v1/account/guest")
    return json({ account_id: next.account_id });
  if (url === "/api/v1/account/me") return json(next);
  throw new Error(`Unexpected request: ${url}`);
}
beforeEach(() => {
  fetchMock.mockReset();
  updated.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", { onLine: true });
  setApiContext("ko-KR");
  setApiContext("ko-KR", current.account_id);
  unsubscribe = subscribeSession(updated);
});
afterEach(() => {
  unsubscribe();
  vi.unstubAllGlobals();
});

describe("session recovery and identity-only responses", () => {
  it("bootstraps from an identity-only guest response and loads the full profile", async () => {
    setApiContext("ko-KR");
    fetchMock.mockImplementation(async (url) => recover(url));
    await expect(refreshSession()).resolves.toEqual(current);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/account/guest",
      "/api/v1/account/me",
    ]);
    expect(
      new Headers(calls("/account/guest")[0][1]?.headers).has(
        "X-Preview-Account",
      ),
    ).toBe(false);
    expect(
      new Headers(calls("/account/me")[0][1]?.headers).get("X-Preview-Account"),
    ).toBe(current.account_id);
    expect(updated).toHaveBeenCalledExactlyOnceWith(current);
  });

  it("recovers the same user and retries the original message body and ID exactly once", async () => {
    const body = JSON.stringify({
      content: "이어갈 메시지",
      client_message_id: crypto.randomUUID(),
    });
    const signal = new AbortController().signal;
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/v1/chats/room/messages")
        return calls("/chats/room/messages").length === 1
          ? unauthorized()
          : new Response("event: accepted\n\ndata: {}\n\n");
      // A locale change during recovery must not rewrite the pending request.
      setApiContext("en-US", current.account_id);
      return recover(url);
    });
    await expect(
      request("/chats/room/messages", {
        method: "POST",
        body,
        signal,
        headers: { "X-Request-ID": "original-request" },
      }),
    ).resolves.toMatchObject({ status: 200 });
    const attempts = calls("/chats/room/messages");
    expect(attempts).toHaveLength(2);
    for (const [, options] of attempts) {
      expect(options).toMatchObject({
        method: "POST",
        body,
        signal,
        credentials: "same-origin",
      });
      const headers = new Headers(options?.headers);
      expect(headers.get("X-Locale")).toBe("ko-KR");
      expect(headers.get("X-Preview-Account")).toBe(current.account_id);
      expect(headers.get("X-Request-ID")).toBe("original-request");
    }
    expect(calls("/account/guest")).toHaveLength(1);
    expect(updated).toHaveBeenCalledExactlyOnceWith(current);
  });

  it("publishes a changed identity without resending the old user's request", async () => {
    const next = { ...current, account_id: "guest-2" };
    fetchMock.mockImplementation(async (url) =>
      url === "/api/v1/chats/room/messages"
        ? unauthorized()
        : recover(url, next),
    );
    await expect(
      request("/chats/room/messages", { method: "POST", body: "original" }),
    ).rejects.toMatchObject({ code: "account_changed", status: 401 });
    expect(calls("/chats/room/messages")).toHaveLength(1);
    expect(updated).toHaveBeenCalledExactlyOnceWith(next);
  });

  it("stops after a second 401 without starting another recovery", async () => {
    fetchMock.mockImplementation(async (url) =>
      url === "/api/v1/home" ? unauthorized() : recover(url),
    );
    await expect(request("/home")).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
    expect(calls("/home")).toHaveLength(2);
    expect(calls("/account/guest")).toHaveLength(1);
    expect(calls("/account/me")).toHaveLength(1);
  });

  it.each(["/account/guest", "/account/me"])(
    "does not recurse or replay when recovery fails at %s",
    async (failedPath) => {
      fetchMock.mockImplementation(async (url) => {
        if (url === "/api/v1/home" || url === `/api/v1${failedPath}`)
          return unauthorized();
        return recover(url);
      });
      await expect(request("/home")).rejects.toMatchObject({
        code: "session_recovery_failed",
        status: 401,
      });
      expect(calls("/home")).toHaveLength(1);
      expect(calls("/account/guest")).toHaveLength(1);
      expect(updated).not.toHaveBeenCalled();
    },
  );

  it("shares recovery across concurrent requests and does not replay an aborted caller", async () => {
    const gate = deferred<Response>();
    const abort = new AbortController();
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/v1/account/guest") return gate.promise;
      if (url === "/api/v1/account/me") return json(current);
      const path = String(url).replace("/api/v1", "");
      return calls(path).length === 1 ? unauthorized() : json({ ok: true });
    });
    const outcomes = Promise.allSettled([
      request("/home", { signal: abort.signal }),
      request("/chats/recent"),
    ]);
    await vi.waitFor(() => expect(calls("/account/guest")).toHaveLength(1));
    abort.abort();
    gate.resolve(json({ account_id: current.account_id }));
    const [first, second] = await outcomes;
    expect(first).toMatchObject({
      status: "rejected",
      reason: { name: "AbortError" },
    });
    expect(second).toMatchObject({
      status: "fulfilled",
      value: { status: 200 },
    });
    expect(calls("/home")).toHaveLength(1);
    expect(calls("/chats/recent")).toHaveLength(2);
    expect(calls("/account/guest")).toHaveLength(1);
  });

  it("reuses completed recovery for a delayed 401 from another in-flight request", async () => {
    const delayed = deferred<Response>();
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/v1/home")
        return calls("/home").length === 1
          ? unauthorized()
          : json({ ok: true });
      if (url === "/api/v1/chats/recent")
        return calls("/chats/recent").length === 1
          ? delayed.promise
          : json({ chats: [] });
      return recover(url);
    });
    const first = request("/home");
    const second = request("/chats/recent");
    await first;
    delayed.resolve(unauthorized());
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(calls("/account/guest")).toHaveLength(1);
    expect(calls("/chats/recent")).toHaveLength(2);
  });

  it("does not overwrite a login or logout that happens while recovery is pending", async () => {
    const delayed = deferred<Response>();
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/v1/home") return unauthorized();
      if (url === "/api/v1/account/me") return delayed.promise;
      return recover(url);
    });
    const outcome = expect(request("/home")).rejects.toMatchObject({
      code: "account_changed",
    });
    await vi.waitFor(() => expect(calls("/account/me")).toHaveLength(1));
    setApiContext("ko-KR", "new-login");
    delayed.resolve(json(current));
    await outcome;
    expect(updated).not.toHaveBeenCalled();
    expect(calls("/home")).toHaveLength(1);
  });

  it("rejects a stale successful response after the account changes", async () => {
    const delayed = deferred<Response>();
    fetchMock.mockReturnValue(delayed.promise);
    const outcome = expect(
      api("/account/me", accountSchema),
    ).rejects.toMatchObject({ code: "account_changed" });
    setApiContext("ko-KR", "new-login");
    delayed.resolve(json(current));
    await outcome;
    expect(calls("/account/guest")).toHaveLength(0);
  });

  it("loads the profile of an issued logout identity without sending the old identity", async () => {
    const next = { ...current, account_id: "logout-guest" };
    fetchMock.mockResolvedValue(json(next));
    await expect(readAccount(next.account_id)).resolves.toEqual(next);
    expect(
      new Headers(calls("/account/me")[0][1]?.headers).get("X-Preview-Account"),
    ).toBe(next.account_id);
    expect(calls("/account/guest")).toHaveLength(0);
  });

  it("rejects a profile that does not match the issued identity", async () => {
    fetchMock.mockImplementation(async (url) =>
      url === "/api/v1/account/guest"
        ? json({ account_id: current.account_id })
        : json({ ...current, account_id: "unexpected" }),
    );
    await expect(refreshSession()).rejects.toMatchObject({
      code: "account_changed",
    });
    expect(updated).not.toHaveBeenCalled();
  });

  it.each([403, 404, 409, 422, 429])(
    "does not recover or retry a client error (%s)",
    async (status) => {
      fetchMock.mockResolvedValue(json({ code: "failed" }, status));
      await expect(request("/home")).rejects.toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not recursively recover a direct guest issuance request", async () => {
    fetchMock.mockResolvedValue(unauthorized());
    await expect(
      request("/account/guest", { method: "POST" }),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("bounded transient retries", () => {
  it("retries a failed read once with the original headers and signal", async () => {
    const signal = new AbortController().signal;
    fetchMock
      .mockResolvedValueOnce(json({ code: "unavailable" }, 503))
      .mockResolvedValueOnce(json({ ok: true }));
    await expect(request("/home", { signal })).resolves.toMatchObject({
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
  });

  it("stops after two failed reads and exposes the server error", async () => {
    fetchMock.mockImplementation(async () =>
      json({ code: "unavailable" }, 503),
    );
    await expect(request("/home")).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries network failures once and normalizes the final failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(request("/home")).rejects.toMatchObject({
      code: "network_error",
      status: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries guest issuance and its profile lookup independently", async () => {
    fetchMock.mockImplementation(async (url) => {
      const path = String(url).replace("/api/v1", "");
      return calls(path).length === 1 ? json({}, 502) : recover(url);
    });
    await expect(refreshSession()).resolves.toEqual(current);
    expect(calls("/account/guest")).toHaveLength(2);
    expect(calls("/account/me")).toHaveLength(2);
    expect(updated).toHaveBeenCalledExactlyOnceWith(current);
  });

  it.each([
    ["POST", "/chats/room/messages"],
    ["POST", "/chats/open"],
    ["PATCH", "/account/me"],
    ["POST", "/account/logout"],
    ["POST", "/account/withdraw"],
    ["DELETE", "/chats/room"],
  ])("does not retry a server failure for %s %s", async (method, path) => {
    fetchMock.mockResolvedValue(json({}, 500));
    await expect(request(path, { method })).rejects.toMatchObject({
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not resend a message after a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      request("/chats/room/messages", { method: "POST" }),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry after abort or identity change", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return json({}, 503);
    });
    await expect(
      request("/home", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementationOnce(async () => {
      setApiContext("ko-KR", "changed");
      return json({}, 503);
    });
    await expect(request("/home")).rejects.toMatchObject({
      code: "account_changed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one transient retry budget across 401 recovery", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/v1/home")
        return calls("/home").length === 2 ? unauthorized() : json({}, 503);
      return recover(url);
    });
    await expect(request("/home")).rejects.toMatchObject({ status: 503 });
    expect(calls("/home")).toHaveLength(3);
    expect(calls("/account/guest")).toHaveLength(1);
  });

  it("keeps validation details for field-specific guidance", async () => {
    const detail = [{ field: "nickname", reason: "too_long" }];
    fetchMock.mockResolvedValue(json({ code: "invalid_input", detail }, 422));
    await expect(
      request("/account/me", { method: "PATCH" }),
    ).rejects.toMatchObject({ code: "invalid_input", status: 422, detail });
  });

  it("reports offline without issuing requests", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(request("/home")).rejects.toMatchObject({ code: "offline" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the HTTP status for an error without a JSON body", async () => {
    fetchMock.mockImplementation(
      async () => new Response("Service unavailable", { status: 503 }),
    );
    await expect(request("/home")).rejects.toMatchObject({
      code: "http_error",
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
