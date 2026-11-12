import { describe, expect, it } from "vitest";
import { characters } from "@/mocks/characters";
import {
  account,
  updateProfile,
  guest,
  home,
  initialState,
  login,
  logout,
  openRoom,
  ownedRoom,
  recordConsents,
  recent,
  roomView,
  settle,
  startTurn,
  updateAdultMode,
} from "@/mocks/engine";
import { sendSchema } from "@/lib/contracts";

/** A guest who agreed to the terms, as the consent modal makes every visitor do. */
function visitor() {
  const state = initialState();
  guest(state);
  recordConsents(state, account(state).consent_items);
  return state;
}
/** A member with one room: chat is for members only. */
function setup() {
  const state = visitor();
  login(state, "google");
  const opened = openRoom(state, characters[0].id, "ko-KR");
  return { state, roomId: opened.room_id };
}
/** A member who signed up earlier on another device: the mock logs in one member per provider. */
function otherMember(state: ReturnType<typeof initialState>) {
  const member = {
    account_id: crypto.randomUUID(),
    is_guest: false,
    nickname: "다른 회원",
    photo_url: null,
    adult_mode: false,
    adult_verified: false,
    adult_verification_rejected: false,
    consent_required: false,
    consent_items: [],
  };
  state.accounts.push(member);
  return member;
}
const input = (content = "안녕!") => ({
  content,
  client_message_id: crypto.randomUUID(),
});
describe("account and conversation contracts", () => {
  it("skips a saved room whose character no longer exists", () => {
    const { state, roomId } = setup();
    const gone = openRoom(state, characters[1].id, "ko-KR").room_id;
    ownedRoom(state, gone).character_id = crypto.randomUUID();
    expect(recent(state, "ko-KR").chats.map((value) => value.room_id)).toEqual([
      roomId,
    ]);
    expect(() => roomView(state, gone, "ko-KR")).toThrow("room_not_found");
    expect(() => startTurn(state, gone, input(), "ko-KR")).toThrow(
      "room_not_found",
    );
  });
  it("starts guests and new members with SAFE ON and hides adult characters", () => {
    const state = initialState();
    guest(state);
    const adult = characters.find((value) => value.is_adult)!;
    expect(account(state)).toMatchObject({
      is_guest: true,
      adult_mode: false,
      adult_verified: false,
      adult_verification_rejected: false,
      consent_required: true,
      consent_items: expect.any(Array),
    });
    expect(home(state, "ko-KR").sections[0].characters).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: adult.id })]),
    );
    expect(login(state, "google")).toMatchObject({
      is_guest: false,
      adult_mode: false,
      adult_verified: false,
      adult_verification_rejected: false,
      consent_required: true,
      consent_items: expect.any(Array),
    });
    recordConsents(state, account(state).consent_items);
    expect(() => openRoom(state, adult.id, "ko-KR")).toThrow(
      "character_not_found",
    );
    expect(logout(state)).toMatchObject({
      is_guest: true,
      adult_mode: false,
      adult_verified: false,
      adult_verification_rejected: false,
      consent_required: true,
      consent_items: expect.any(Array),
    });
  });
  it("keeps chat for members: consent first, then a login", () => {
    const state = initialState();
    guest(state);
    expect(() => openRoom(state, characters[0].id, "ko-KR")).toThrow(
      "consent_required",
    );
    recordConsents(state, account(state).consent_items);
    expect(() => openRoom(state, characters[0].id, "ko-KR")).toThrow(
      "member_required",
    );
    expect(state.rooms).toHaveLength(0);
    login(state, "google");
    expect(openRoom(state, characters[0].id, "ko-KR").created).toBe(true);
  });
  it.each(["member"])(
    "normalizes a saved unlocked %s without changing identity or conversations",
    () => {
      const { state, roomId } = setup();
      const saved = account(state);
      saved.adult_mode = true;
      const restored = structuredClone(state);
      expect(guest(restored)).toMatchObject({
        account_id: saved.account_id,
        adult_mode: false,
        adult_verified: false,
        adult_verification_rejected: false,
        consent_required: false,
        consent_items: expect.any(Array),
      });
      expect(ownedRoom(restored, roomId).messages).toEqual(
        state.rooms[0].messages,
      );
      expect(restored.accounts[0].adult_mode).toBe(false);
    },
  );
  it("normalizes an existing unverified member when logging back in", () => {
    const { state } = setup();
    const member = account(state);
    logout(state);
    member.adult_mode = true;
    expect(login(state, "google")).toMatchObject({
      account_id: member.account_id,
      adult_mode: false,
      adult_verified: false,
      adult_verification_rejected: false,
      consent_required: false,
      consent_items: expect.any(Array),
    });
  });
  it("reuses the account and opens only one room for the same character", () => {
    const { state, roomId } = setup();
    const original = account(state).account_id;
    expect(guest(state).account_id).toBe(original);
    expect(openRoom(state, characters[0].id, "zh-TW")).toEqual({
      room_id: roomId,
      created: false,
    });
    expect(state.accounts).toHaveLength(1);
    expect(state.rooms).toHaveLength(1);
  });
  it("preserves message language when changing display language; future replies use the new locale", () => {
    const { state, roomId } = setup();
    const korean = roomView(state, roomId, "ko-KR").messages[0].content;
    const english = roomView(state, roomId, "en-US");
    expect(english.character.name).toBe(characters[0].texts["en-US"].name);
    expect(english.messages[0].content).toBe(korean);
    const turn = startTurn(state, roomId, input(), "en-US", 100);
    settle(state, turn.finishes_at);
    expect(roomView(state, roomId, "en-US").messages.at(-1)?.content).toBe(
      characters[0].texts["en-US"].replies[0],
    );
  });
  it("rejects simultaneous generation and conflicting idempotency keys without another message", () => {
    const { state, roomId } = setup();
    const first = input();
    const turn = startTurn(state, roomId, first, "ko-KR", 100);
    expect(() => startTurn(state, roomId, first, "ko-KR", 200)).toThrow(
      "generation_in_progress",
    );
    expect(() => startTurn(state, roomId, input(), "ko-KR", 200)).toThrow(
      "generation_in_progress",
    );
    expect(() =>
      startTurn(state, roomId, { ...first, content: "changed" }, "ko-KR", 200),
    ).toThrow("invalid_input");
    settle(state, turn.finishes_at);
    expect(
      startTurn(state, roomId, first, "ko-KR", 5000).assistant_message_id,
    ).toBe(turn.assistant_message_id);
    settle(state, 6000);
    expect(state.rooms[0].messages).toHaveLength(3);
  });
  it("restores pending work from persisted timestamps without a background process", () => {
    const { state, roomId } = setup();
    const turn = startTurn(state, roomId, input(), "zh-TW", 100);
    const restored = JSON.parse(JSON.stringify(state));
    settle(restored, turn.finishes_at - 1);
    expect(roomView(restored, roomId, "zh-TW").generating).toBe(true);
    settle(restored, turn.finishes_at);
    expect(roomView(restored, roomId, "zh-TW").generating).toBe(false);
    expect(restored.rooms[0].messages).toHaveLength(3);
  });
  it("retains a failed input for recovery but excludes it from recent previews", () => {
    const { state, roomId } = setup();
    state.scenario.response = "fail";
    const firstMessage = state.rooms[0].messages[0].content;
    const turn = startTurn(
      state,
      roomId,
      input("failed secret input"),
      "ko-KR",
      100,
    );
    settle(state, turn.finishes_at);
    expect(roomView(state, roomId, "ko-KR").messages.at(-1)?.turn_status).toBe(
      "failed",
    );
    expect(recent(state, "ko-KR").chats[0].last_message).toBe(firstMessage);
    expect(state.scenario.response).toBe("normal");
    expect(JSON.stringify(state.events)).not.toContain("failed secret input");
    expect(
      startTurn(
        state,
        roomId,
        { content: turn.content, client_message_id: turn.client_message_id },
        "ko-KR",
      ).status,
    ).toBe("failed");
  });
  it("finishes a reply after logout and shows the member's rooms on the next login", () => {
    const { state, roomId } = setup();
    const user = account(state);
    const turn = startTurn(state, roomId, input(), "ko-KR", 100);
    logout(state);
    expect(() => openRoom(state, characters[1].id, "ko-KR")).toThrow();
    expect(login(state, "google").account_id).toBe(user.account_id);
    settle(state, turn.finishes_at);
    expect(recent(state, "ko-KR").chats.map((value) => value.room_id)).toEqual([
      roomId,
    ]);
    expect(state.rooms[0].messages).toHaveLength(3);
  });
  it("denies the next guest the member's rooms after logout", () => {
    const { state, roomId } = setup();
    const google = account(state);
    logout(state);
    expect(account(state).account_id).not.toBe(google.account_id);
    expect(() => ownedRoom(state, roomId)).toThrow("room_not_found");
    expect(recent(state, "ko-KR").chats).toEqual([]);
  });
  it("rejects a nickname another member uses", () => {
    const { state } = setup();
    const other = otherMember(state);
    expect(() => updateProfile(state, { nickname: other.nickname! })).toThrow(
      "nickname_taken",
    );
  });
  it("deletes only the withdrawing member and creates a new identity on rejoin", () => {
    const { state } = setup();
    const other = otherMember(state);
    const google = account(state);
    logout(state, true);
    expect(
      state.accounts.some((value) => value.account_id === google.account_id),
    ).toBe(false);
    expect(
      state.accounts.some((value) => value.account_id === other.account_id),
    ).toBe(true);
    expect(login(state, "google").account_id).not.toBe(google.account_id);
    expect(recent(state, "ko-KR").chats).toEqual([]);
  });
  it("soft deletion blocks new turns while already accepted work finishes", () => {
    const { state, roomId } = setup();
    const turn = startTurn(state, roomId, input(), "ko-KR", 100);
    ownedRoom(state, roomId).deleted = true;
    expect(() => ownedRoom(state, roomId)).toThrow("room_not_found");
    expect(() => startTurn(state, roomId, input(), "ko-KR")).toThrow(
      "room_not_found",
    );
    settle(state, turn.finishes_at);
    expect(state.rooms[0].messages).toHaveLength(3);
    expect(recent(state, "ko-KR").chats).toHaveLength(0);
    expect(openRoom(state, characters[0].id, "ko-KR").room_id).not.toBe(roomId);
  });
  it("lets verified members switch SAFE and keeps existing rooms when SAFE is enabled", () => {
    const { state } = setup();
    const adult = characters.find((value) => value.is_adult)!;
    account(state).adult_verified = true;
    expect(updateAdultMode(state, true).adult_mode).toBe(true);
    expect(home(state, "ko-KR").sections[0].characters).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: adult.id })]),
    );
    const roomId = openRoom(state, adult.id, "ko-KR").room_id;
    expect(updateAdultMode(state, false).adult_mode).toBe(false);
    expect(
      home(state, "ko-KR").sections[0].characters.some(
        (value) => value.id === adult.id,
      ),
    ).toBe(false);
    expect(openRoom(state, adult.id, "ko-KR").room_id).toBe(roomId);
    ownedRoom(state, roomId).deleted = true;
    expect(() => openRoom(state, adult.id, "ko-KR")).toThrow(
      "character_not_found",
    );
  });
  it("attributes completion to the room owner after logout", () => {
    const { state, roomId } = setup();
    const owner = account(state);
    const turn = startTurn(state, roomId, input(), "ko-KR", 100);
    logout(state);
    settle(state, turn.finishes_at);
    expect(state.events.at(-1)?.account_id).toBe(owner.account_id);
  });
  it("enforces nonblank content, the 4000 character limit, and UUID send IDs", () => {
    expect(sendSchema.safeParse(input("   ")).success).toBe(false);
    expect(sendSchema.safeParse(input("가".repeat(4001))).success).toBe(false);
    expect(sendSchema.safeParse(input("가".repeat(4000))).success).toBe(true);
    expect(
      sendSchema.safeParse({ content: "hello", client_message_id: "bad" })
        .success,
    ).toBe(false);
  });
});
