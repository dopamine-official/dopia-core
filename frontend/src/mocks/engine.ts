import {
  ApiError,
  type Account,
  type Message,
  type Scenario,
  type LocalEvent,
} from "@/lib/contracts";
import { type Locale } from "@/i18n";
import { characters, characterInfo, getCharacter } from "./characters";

type StoredAccount = Account & { provider?: "google" | "apple" };
export type Turn = {
  client_message_id: string;
  user_message_id: string;
  assistant_message_id: string;
  content: string;
  response: string;
  started_at: number;
  finishes_at: number;
  status: "generating" | "completed" | "failed";
  behavior: Scenario["response"];
};
export type StoredRoom = {
  room_id: string;
  owner_id: string;
  character_id: string;
  is_adult: boolean;
  messages: Message[];
  turns: Turn[];
  updated_at: string;
  deleted: boolean;
};
export type State = {
  version: 1;
  active_account_id: string | null;
  accounts: StoredAccount[];
  rooms: StoredRoom[];
  scenario: Scenario;
  events: LocalEvent[];
};
export const initialState = (): State => ({
  version: 1,
  active_account_id: null,
  accounts: [],
  rooms: [],
  scenario: { response: "normal", home: "normal" },
  events: [],
});
const id = () => crypto.randomUUID();
export function event(
  state: State,
  name: string,
  properties: LocalEvent["properties"] = {},
  accountId = state.active_account_id ?? "",
) {
  state.events.push({
    name,
    at: new Date().toISOString(),
    account_id: accountId,
    properties,
  });
  state.events = state.events.slice(-100);
}
export function account(state: State): StoredAccount {
  const result = state.accounts.find(
    (value) => value.account_id === state.active_account_id,
  );
  if (!result) throw new ApiError("unauthorized", 401);
  // Normalize accounts saved by the previously unlocked development preview.
  if (result.is_guest) result.adult_verified = false;
  if (!result.adult_verified) result.adult_mode = false;
  return result;
}
export function guest(state: State) {
  if (
    state.accounts.some((value) => value.account_id === state.active_account_id)
  )
    return account(state);
  const result: StoredAccount = {
    account_id: id(),
    is_guest: true,
    nickname: null,
    photo_url: null,
    adult_mode: false,
    adult_verified: false,
  };
  state.accounts.push(result);
  state.active_account_id = result.account_id;
  event(state, "guest_created");
  return result;
}
export function login(state: State, provider: "google" | "apple") {
  const previous = account(state);
  if (!previous.is_guest) return previous;
  let member = state.accounts.find((value) => value.provider === provider);
  if (!member) {
    let nickname = provider === "google" ? "Google Explorer" : "Apple Explorer";
    while (state.accounts.some((value) => value.nickname === nickname))
      nickname += " ✦";
    member = {
      account_id: id(),
      is_guest: false,
      nickname,
      photo_url: null,
      adult_mode: false,
      adult_verified: false,
      provider,
    };
    state.accounts.push(member);
  }
  state.rooms
    .filter((room) => room.owner_id === previous.account_id)
    .forEach((room) => {
      room.owner_id = member.account_id;
    });
  state.accounts = state.accounts.filter(
    (value) => value.account_id !== previous.account_id,
  );
  state.events.forEach((value) => {
    if (value.account_id === previous.account_id)
      value.account_id = member.account_id;
  });
  state.active_account_id = member.account_id;
  event(state, "login_succeeded", { provider });
  return account(state);
}
export function updateAdultMode(state: State, adultMode: boolean) {
  const user = account(state);
  if (user.is_guest)
    throw new ApiError(
      adultMode ? "adult_verification_required" : "member_required",
      403,
    );
  if (!user.adult_verified)
    throw new ApiError("adult_verification_required", 403);
  user.adult_mode = adultMode;
  event(state, "safe_mode_changed", { adult_mode: adultMode });
  return user;
}
export function logout(state: State, withdraw = false) {
  const previous = account(state);
  if (withdraw) {
    if (previous.is_guest) throw new ApiError("forbidden", 403);
    state.accounts = state.accounts.filter(
      (value) => value.account_id !== previous.account_id,
    );
    state.rooms = state.rooms.filter(
      (value) => value.owner_id !== previous.account_id,
    );
    state.events = state.events.filter(
      (value) => value.account_id !== previous.account_id,
    );
  } else event(state, "logout_succeeded");
  state.active_account_id = null;
  return guest(state);
}
export function updateProfile(
  state: State,
  values: { nickname?: string; photo_url?: string },
) {
  const user = account(state);
  if (user.is_guest) throw new ApiError("forbidden", 403);
  if (values.nickname !== undefined) {
    const nickname = values.nickname.trim();
    if (!nickname)
      throw new ApiError("invalid_input", 422, [
        { field: "nickname", reason: "required" },
      ]);
    if (
      state.accounts.some(
        (other) =>
          other.account_id !== user.account_id && other.nickname === nickname,
      )
    )
      throw new ApiError("nickname_taken", 409);
    user.nickname = nickname;
  }
  if (values.photo_url !== undefined) user.photo_url = values.photo_url;
  event(state, "profile_updated");
  return user;
}
export function home(state: State, locale: Locale) {
  const user = account(state);
  if (state.scenario.home === "empty") return { banner: null, sections: [] };
  const visible = characters.filter(
    (value) => !value.is_adult || user.adult_mode,
  );
  return {
    banner: {
      character_id: characters[0].id,
      name: characters[0].texts[locale].name,
      image_url: "/images/main_banner.png",
    },
    sections: [
      {
        id: "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
        name: {
          "ko-KR": "오리지널",
          "zh-TW": "原創角色",
          "en-US": "Original characters",
        }[locale],
        characters: visible.map((value) => ({
          ...characterInfo(value, locale),
          tagline: value.texts[locale].tagline,
          creator_name: value.creator_name,
        })),
      },
    ],
  };
}
export function ownedRoom(state: State, roomId: string) {
  const user = account(state);
  const room = state.rooms.find(
    (value) =>
      value.room_id === roomId &&
      !value.deleted &&
      value.owner_id === user.account_id,
  );
  if (!room) throw new ApiError("room_not_found", 404);
  return room;
}
export function openRoom(state: State, characterId: string, locale: Locale) {
  const user = account(state);
  const existing = state.rooms
    .filter(
      (room) =>
        !room.deleted &&
        room.owner_id === user.account_id &&
        room.character_id === characterId,
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (existing) return { room_id: existing.room_id, created: false };
  const character = getCharacter(characterId);
  if (!character || (character.is_adult && !user.adult_mode))
    throw new ApiError("character_not_found", 404);
  const room: StoredRoom = {
    room_id: id(),
    owner_id: user.account_id,
    character_id: character.id,
    is_adult: character.is_adult,
    messages: [
      {
        id: id(),
        role: "assistant",
        content: character.texts[locale].first_message,
        created_at: new Date().toISOString(),
        client_message_id: null,
        turn_status: null,
        error_code: null,
      },
    ],
    turns: [],
    updated_at: new Date().toISOString(),
    deleted: false,
  };
  state.rooms.push(room);
  event(state, "chat_room_opened", {
    character_id: characterId,
    room_id: room.room_id,
  });
  return { room_id: room.room_id, created: true };
}
export function settle(state: State, now = Date.now()) {
  for (const room of state.rooms)
    for (const turn of room.turns) {
      if (turn.status !== "generating" || turn.finishes_at > now) continue;
      const userMessage = room.messages.find(
        (value) => value.id === turn.user_message_id,
      )!;
      if (turn.behavior === "fail") {
        turn.status = "failed";
        userMessage.turn_status = "failed";
        userMessage.error_code = "mock_response_failed";
      } else {
        turn.status = "completed";
        userMessage.turn_status = "completed";
        room.messages.push({
          id: turn.assistant_message_id,
          role: "assistant",
          content: turn.response,
          created_at: new Date(turn.finishes_at).toISOString(),
          client_message_id: turn.client_message_id,
          turn_status: "completed",
          error_code: null,
        });
        room.updated_at = new Date(turn.finishes_at).toISOString();
      }
      event(
        state,
        turn.status === "failed" ? "turn_failed" : "turn_completed",
        { room_id: room.room_id, client_message_id: turn.client_message_id },
        room.owner_id,
      );
    }
}
export function roomView(state: State, roomId: string, locale: Locale) {
  const room = ownedRoom(state, roomId);
  return {
    room_id: roomId,
    character: characterInfo(getCharacter(room.character_id)!, locale),
    messages: room.messages,
    generating: room.turns.some((turn) => turn.status === "generating"),
  };
}
export function recent(state: State, locale: Locale) {
  const user = account(state);
  return {
    chats: state.rooms
      .filter((room) => !room.deleted && room.owner_id === user.account_id)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((room) => ({
        room_id: room.room_id,
        character: characterInfo(getCharacter(room.character_id)!, locale),
        last_message:
          room.messages.filter((value) => value.turn_status !== "failed").at(-1)
            ?.content ?? null,
        updated_at: room.updated_at,
      })),
  };
}
export function startTurn(
  state: State,
  roomId: string,
  input: { content: string; client_message_id: string },
  locale: Locale,
  now = Date.now(),
): Turn {
  const room = ownedRoom(state, roomId);
  const existing = room.turns.find(
    (turn) => turn.client_message_id === input.client_message_id,
  );
  if (existing) {
    if (existing.content !== input.content)
      throw new ApiError("invalid_input", 422, [
        { field: "client_message_id", reason: "content_mismatch" },
      ]);
    if (existing.status === "generating")
      throw new ApiError("generation_in_progress", 409);
    return existing;
  }
  if (room.turns.some((turn) => turn.status === "generating"))
    throw new ApiError("generation_in_progress", 409);
  const replies = getCharacter(room.character_id)!.texts[locale].replies;
  const behavior = state.scenario.response;
  if (behavior === "fail" || behavior === "disconnect")
    state.scenario.response = "normal";
  const turn: Turn = {
    ...input,
    user_message_id: id(),
    assistant_message_id: id(),
    response:
      replies[
        room.turns.filter((value) => value.status === "completed").length %
          replies.length
      ],
    started_at: now,
    finishes_at: now + (behavior === "slow" ? 6500 : 2200),
    status: "generating",
    behavior,
  };
  room.messages.push({
    id: turn.user_message_id,
    role: "user",
    content: input.content,
    created_at: new Date(now).toISOString(),
    client_message_id: input.client_message_id,
    turn_status: "generating",
    error_code: null,
  });
  room.turns.push(turn);
  room.updated_at = new Date(now).toISOString();
  event(state, "message_sent", {
    room_id: roomId,
    client_message_id: input.client_message_id,
  });
  return turn;
}
