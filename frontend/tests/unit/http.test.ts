import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setupServer } from "msw/node";
import { handlers } from "@/mocks/handlers";
import { characters } from "@/mocks/characters";
import { initialState, settle, type State } from "@/mocks/engine";
import {
  accountIdentitySchema,
  accountSchema,
  homeSchema,
  openSchema,
  roomSchema,
} from "@/lib/contracts";
import { readStream } from "@/lib/api";

// HTTP tests use an isolated transactional snapshot; browser E2E uses real IndexedDB.
const store = vi.hoisted(() => ({ state: null as State | null }));
vi.mock("@/mocks/storage", () => ({
  withState: async (operation: (state: State) => unknown) => {
    const draft = structuredClone(store.state ?? initialState());
    settle(draft);
    const result = operation(draft);
    store.state = draft;
    return structuredClone(result);
  },
}));
vi.stubGlobal("location", new URL("http://localhost"));
const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  store.state = null;
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
const call = (path: string, init: RequestInit = {}) =>
  fetch(`http://localhost/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Locale": "ko-KR",
      "X-Region": "TW",
      ...init.headers,
    },
  });
/** A room of a member: the guest agrees to the terms and logs in first (chat is for members). */
async function room() {
  await call("/account/guest", { method: "POST" });
  const me = await (await call("/account/me")).json();
  await call("/account/me/consents", {
    method: "POST",
    body: JSON.stringify({
      items: me.consent_items.map((item: { id: string; version: string }) => ({
        id: item.id,
        version: item.version,
      })),
    }),
  });
  await call("/mock/login", {
    method: "POST",
    body: JSON.stringify({ provider: "google" }),
  });
  const response = await call("/chats/open", {
    method: "POST",
    body: JSON.stringify({ character_id: characters[0].id }),
  });
  return openSchema.parse(await response.json()).room_id;
}
describe("mock HTTP boundary", () => {
  it("returns contract-shaped localized data and structured validation errors", async () => {
    const guest = await call("/account/guest", { method: "POST" });
    const issued = await guest.json();
    expect(issued).toEqual({ account_id: expect.any(String) });
    const profile = accountSchema.parse(
      await (await call("/account/me")).json(),
    );
    expect(profile).toMatchObject({
      account_id: issued.account_id,
      is_guest: true,
      adult_mode: false,
      adult_verified: false,
      adult_verification_rejected: false,
      consent_required: true,
      consent_items: expect.any(Array),
    });
    const response = await call("/home", { headers: { "X-Locale": "en-US" } });
    expect(homeSchema.parse(await response.json()).sections[0].name).toBe(
      "Original characters",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bad = {
      method: "POST",
      body: JSON.stringify({ character_id: "bad" }),
    };
    // Like the server: who may chat comes before the body.
    const refused = await call("/chats/open", bad);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "consent_required" });
    await room();
    const invalid = await call("/chats/open", bad);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      code: "invalid_input",
      detail: [{ field: "character_id", reason: "invalid_format" }],
    });
  });
  it.each(["logout", "withdraw"])(
    "returns only an identity from %s, followed by a separate guest profile",
    async (action) => {
      await call("/account/guest", { method: "POST" });
      const loggedIn = await call("/mock/login", {
        method: "POST",
        body: JSON.stringify({ provider: "google" }),
      });
      const member = accountSchema.parse(await loggedIn.json());
      const response = await call(`/account/${action}`, { method: "POST" });
      expect(response.status).toBe(200);
      const issued = await response.json();
      expect(issued).toEqual({ account_id: expect.any(String) });
      expect(issued.account_id).not.toBe(member.account_id);
      const profile = await call("/account/me", {
        headers: { "X-Preview-Account": issued.account_id },
      });
      expect(accountSchema.parse(await profile.json())).toMatchObject({
        account_id: issued.account_id,
        is_guest: true,
        adult_mode: false,
      });
    },
  );
  it.each(["guest", "unverified member"])(
    "rejects direct SAFE changes from a %s without exposing adult cards",
    async (kind) => {
      await call("/account/guest", { method: "POST" });
      if (kind !== "guest")
        await call("/mock/login", {
          method: "POST",
          body: JSON.stringify({ provider: "google" }),
        });
      for (const adult_mode of [true, false]) {
        const response = await call("/account/me/adult_mode", {
          method: "PATCH",
          body: JSON.stringify({ adult_mode }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code:
            kind === "guest" && !adult_mode
              ? "member_required"
              : "adult_verification_required",
        });
      }
      expect(
        accountSchema.parse(await (await call("/account/me")).json()),
      ).toMatchObject({ adult_mode: false, adult_verified: false });
      const adult = characters.find((value) => value.is_adult)!;
      const home = homeSchema.parse(await (await call("/home")).json());
      expect(
        home.sections[0].characters.some((value) => value.id === adult.id),
      ).toBe(false);
      expect(
        store.state!.events.some((value) => value.name === "safe_mode_changed"),
      ).toBe(false);
    },
  );
  it("persists verified member SAFE changes and filters home using the saved value", async () => {
    await call("/account/guest", { method: "POST" });
    const response = await call("/mock/login", {
      method: "POST",
      body: JSON.stringify({ provider: "google" }),
    });
    const member = accountSchema.parse(await response.json());
    // Verification is a test fixture; the app has no verification shortcut.
    store.state!.accounts.find(
      (value) => value.account_id === member.account_id,
    )!.adult_verified = true;
    const adult = characters.find((value) => value.is_adult)!;
    for (const adult_mode of [true, false]) {
      const changed = await call("/account/me/adult_mode", {
        method: "PATCH",
        body: JSON.stringify({ adult_mode }),
      });
      expect(changed.status).toBe(200);
      expect(accountSchema.parse(await changed.json())).toMatchObject({
        adult_mode,
        adult_verified: true,
        adult_verification_rejected: false,
        consent_required: true,
        consent_items: expect.any(Array),
      });
      expect(
        accountSchema.parse(await (await call("/account/me")).json())
          .adult_mode,
      ).toBe(adult_mode);
      const home = homeSchema.parse(await (await call("/home")).json());
      expect(
        home.sections[0].characters.some((value) => value.id === adult.id),
      ).toBe(adult_mode);
    }
  });
  it("serves a real SSE stream, persists its result and replays the same send without duplication", async () => {
    const roomId = await room();
    const input = {
      client_message_id: crypto.randomUUID(),
      content: "HTTP test",
    };
    const response = await call(`/chats/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events: string[] = [];
    await readStream(response, (value) => events.push(value.event));
    expect(events[0]).toBe("accepted");
    expect(events).toContain("token");
    expect(events.at(-1)).toBe("completed");
    const replay = await call(`/chats/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    const replayEvents: string[] = [];
    await readStream(replay, (value) => replayEvents.push(value.event));
    expect(replayEvents).toEqual(["accepted", "completed"]);
    expect(
      roomSchema.parse(await (await call(`/chats/${roomId}`)).json()).messages,
    ).toHaveLength(3);
  });
  it("consumes a one-shot home failure and allows retry", async () => {
    await call("/account/guest", { method: "POST" });
    await call("/mock/scenario", {
      method: "PUT",
      body: JSON.stringify({ home: "error", response: "normal" }),
    });
    expect((await call("/home")).status).toBe(503);
    expect((await call("/home")).status).toBe(200);
  });
  it("rejects stale account requests after a login transition", async () => {
    const response = await call("/account/guest", { method: "POST" });
    const guest = accountIdentitySchema.parse(await response.json());
    await call("/mock/login", {
      method: "POST",
      body: JSON.stringify({ provider: "google" }),
    });
    const stale = await call("/account/me", {
      headers: { "X-Preview-Account": guest.account_id },
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ code: "account_changed" });
  });
});
