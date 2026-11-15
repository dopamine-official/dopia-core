import {
  ApiError,
  type Account,
  type Message,
  type Scenario,
  type LocalEvent,
} from "@/lib/contracts";
import { ageConfig, regionToday, type Locale } from "@/i18n";
import { consentItems } from "./consents";
import {
  characters,
  characterInfo,
  getCharacter,
  type Character,
} from "./characters";

// `character_creation_enabled` is worked out on every read, so saved accounts need not carry it.
type StoredAccount = Omit<Account, "character_creation_enabled"> & {
  character_creation_enabled?: boolean;
  provider?: "google";
};
type CharacterStatus = "draft" | "pending" | "approved" | "rejected";
export type StoredImage = {
  id: string;
  name: string;
  description: string;
  image_url: string;
  position: number;
};
/** A character a member made in the preview. Nobody approves here: a submit stays in review. */
export type StoredCharacter = {
  id: string;
  owner_id: string;
  status: CharacterStatus;
  rejection_reason: string | null;
  texts: Record<string, string>;
  gender: "female" | "male" | null;
  age: number | null;
  status_window_enabled: boolean;
  is_adult: boolean;
  image_url: string | null;
  images: StoredImage[];
  updated_at: string;
  deleted: boolean;
};
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
  // Kept apart from the account so it never goes out in a response (ACCOUNT 5-1-3).
  compliance?: Record<string, Compliance>;
  characters?: StoredCharacter[];
};
type Compliance = {
  consents: string[];
  gender?: "male" | "female";
  birth_date?: string;
};
function compliance(state: State, accountId: string): Compliance {
  state.compliance ??= {};
  return (state.compliance[accountId] ??= { consents: [] });
}
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
  const record = compliance(state, result.account_id);
  result.adult_verification_rejected =
    !result.is_guest && !!record.birth_date && !result.adult_verified;
  // The preview has no list of creators: every member may make characters.
  result.character_creation_enabled = !result.is_guest;
  result.consent_items = consentItems;
  result.consent_required = consentItems.some(
    (item) =>
      item.required && !record.consents.includes(`${item.id}@${item.version}`),
  );
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
    adult_verification_rejected: false,
    consent_required: true,
    consent_items: consentItems,
  };
  state.accounts.push(result);
  state.active_account_id = result.account_id;
  event(state, "guest_created");
  return result;
}
export function login(state: State, provider: "google") {
  const previous = account(state);
  if (!previous.is_guest) return previous;
  let member = state.accounts.find((value) => value.provider === provider);
  if (!member) {
    let nickname = "Google Explorer";
    while (state.accounts.some((value) => value.nickname === nickname))
      nickname += " ✦";
    member = {
      account_id: id(),
      is_guest: false,
      nickname,
      photo_url: null,
      adult_mode: false,
      adult_verified: false,
      adult_verification_rejected: false,
      consent_required: true,
      consent_items: consentItems,
      provider,
    };
    state.accounts.push(member);
  }
  // A guest has no rooms to bring along: chat is for members only (CHAT 4-1-1).
  state.accounts = state.accounts.filter(
    (value) => value.account_id !== previous.account_id,
  );
  state.events.forEach((value) => {
    if (value.account_id === previous.account_id)
      value.account_id = member.account_id;
  });
  copyConsents(state, previous.account_id, member.account_id);
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
function copyConsents(state: State, from: string, to: string) {
  const target = compliance(state, to);
  for (const value of compliance(state, from).consents)
    if (!target.consents.includes(value)) target.consents.push(value);
}
export function recordConsents(
  state: State,
  items: { id: string; version: string }[],
) {
  const user = account(state);
  const current = new Map(consentItems.map((item) => [item.id, item]));
  if (
    !items.length ||
    items.some((value) => current.get(value.id)?.version !== value.version) ||
    consentItems.some(
      (item) => item.required && !items.some((value) => value.id === item.id),
    )
  )
    throw new ApiError("invalid_input", 422, [
      { field: "items", reason: "invalid" },
    ]);
  const record = compliance(state, user.account_id);
  const recorded: string[] = [];
  for (const value of items) {
    const key = `${value.id}@${value.version}`;
    if (record.consents.includes(key)) continue;
    record.consents.push(key);
    recorded.push(value.id);
  }
  // Like the server (TRACKING-PLAN 8-1-9): only a new record counts.
  if (recorded.length)
    event(state, "consents_recorded", {
      items: recorded,
      is_guest: user.is_guest,
    });
  return account(state);
}
/** Same rule as chat-server: full years on the UTC date, one submission per account. */
export function verifyAdult(state: State, gender: string, birthDate: string) {
  const user = account(state);
  if (user.is_guest) throw new ApiError("member_required", 403);
  if (ageConfig.verification_method !== "birth_date_only")
    throw new ApiError("adult_verification_unavailable", 403);
  const today = regionToday();
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(birthDate) &&
    new Date(`${birthDate}T00:00:00Z`).toISOString().slice(0, 10) ===
      birthDate &&
    birthDate >= "1900-01-01" &&
    birthDate <= today;
  if ((gender !== "male" && gender !== "female") || !valid)
    throw new ApiError("invalid_input", 422);
  const record = compliance(state, user.account_id);
  if (record.birth_date)
    throw new ApiError("adult_verification_submitted", 409);
  const [year, month, day] = birthDate.split("-").map(Number);
  const [nowYear, nowMonth, nowDay] = today.split("-").map(Number);
  const age =
    nowYear - year - (nowMonth * 100 + nowDay < month * 100 + day ? 1 : 0);
  record.gender = gender;
  record.birth_date = birthDate;
  const passed = age >= ageConfig.adult_age;
  event(state, "adult_verification_submitted", {
    result: passed ? "passed" : "rejected",
    gender,
    age,
  });
  if (passed) {
    user.adult_verified = true;
    user.adult_mode = true;
    event(state, "safe_mode_changed", { adult_mode: true });
  }
  return account(state);
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
    state.characters = state.characters?.filter(
      (value) => value.owner_id !== previous.account_id,
    );
    state.events = state.events.filter(
      (value) => value.account_id !== previous.account_id,
    );
  } else event(state, "logout_succeeded");
  state.active_account_id = null;
  guest(state);
  return account(state);
}
export function updateProfile(
  state: State,
  values: { nickname?: string; photo_url?: string },
) {
  const user = account(state);
  if (user.is_guest) throw new ApiError("forbidden", 403);
  // Same as chat-server: a save with nothing to change is invalid input.
  if (values.nickname === undefined && values.photo_url === undefined)
    throw new ApiError("invalid_input", 422);
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
/** A preview character, or one a member made here, in the shape chat uses. */
function lookup(state: State, characterId: string): Character | undefined {
  const fixed = getCharacter(characterId);
  if (fixed) return fixed;
  const made = state.characters?.find((value) => value.id === characterId);
  if (!made) return undefined;
  const text = (key: string) => made.texts[key] ?? "";
  const initial = made.status_window_enabled
    ? text("status_window_initial")
    : "";
  const content = {
    name: text("name"),
    tagline: text("tagline"),
    first_message: initial
      ? `${text("first_message")}\n<status>\n${initial}\n</status>`
      : text("first_message"),
    replies: ["*고개를 끄덕인다.* 계속 말해 봐."],
  };
  return {
    id: made.id,
    image_url: made.image_url ?? "/images/mock_gray.svg",
    creator_name:
      state.accounts.find((value) => value.account_id === made.owner_id)
        ?.nickname ?? "",
    is_adult: made.is_adult,
    texts: { "ko-KR": content, "zh-TW": content, "en-US": content },
  };
}
export function home(state: State, locale: Locale) {
  const user = account(state);
  if (state.scenario.home === "empty") return { banner: null, sections: [] };
  const visible = characters.filter(
    (value) => !value.is_adult || user.adult_mode,
  );
  return {
    // A banner is a picture with an optional link; it has nothing to do with a character.
    banner: {
      id: "9c1e4b7a-2d3f-4a5b-8c6d-0e1f2a3b4c5d",
      image_url: "/images/mock_gray.svg",
      link_url: null as string | null,
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
      value.owner_id === user.account_id &&
      // A saved room can outlive its preview character (./characters.ts changes freely).
      lookup(state, value.character_id),
  );
  if (!room) throw new ApiError("room_not_found", 404);
  return room;
}
/** Chat waits for the required consents, then is for members only (CHAT 4-1-1, 4-1-3). */
export function chatter(state: State) {
  const user = account(state);
  if (user.consent_required) throw new ApiError("consent_required", 403);
  if (user.is_guest) throw new ApiError("member_required", 403);
  return user;
}
export function openRoom(state: State, characterId: string, locale: Locale) {
  const user = chatter(state);
  const character = lookup(state, characterId);
  if (!character) throw new ApiError("character_not_found", 404);
  // A character made here is open to its creator only, once submitted (CHARACTER 4-1-4).
  const made = state.characters?.find((value) => value.id === characterId);
  if (
    made &&
    (made.deleted ||
      made.status === "draft" ||
      made.owner_id !== user.account_id)
  )
    throw new ApiError("character_not_found", 404);
  const existing = state.rooms
    .filter(
      (room) =>
        !room.deleted &&
        room.owner_id === user.account_id &&
        room.character_id === characterId,
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (existing) return { room_id: existing.room_id, created: false };
  if (character.is_adult && !user.adult_mode)
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
  // A room whose preview character was removed is hidden everywhere, so nobody could
  // delete it: drop it from storage here.
  state.rooms = state.rooms.filter((room) => lookup(state, room.character_id));
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
    character: characterInfo(lookup(state, room.character_id)!, locale),
    messages: room.messages,
    generating: room.turns.some((turn) => turn.status === "generating"),
  };
}
export function recent(state: State, locale: Locale) {
  const user = account(state);
  return {
    chats: state.rooms
      .filter(
        (room) =>
          !room.deleted &&
          room.owner_id === user.account_id &&
          // Like the backend, skip a room whose character cannot be found.
          lookup(state, room.character_id),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((room) => ({
        room_id: room.room_id,
        character: characterInfo(lookup(state, room.character_id)!, locale),
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
  chatter(state);
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
  const replies = lookup(state, room.character_id)!.texts[locale].replies;
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

// ---------- character creation (CHARACTER web 4-1-6 to 4-1-11) ----------
const TEXT_LIMITS: Record<string, number> = {
  name: 30,
  character_name: 30,
  tagline: 35,
  personality: 2000,
  speech_style: 2000,
  world_setting: 6000,
  first_message: 3000,
  status_window_format: 500,
  status_window_initial: 500,
  status_window_rules: 1000,
};
const REQUIRED = [
  "name",
  "character_name",
  "tagline",
  "personality",
  "speech_style",
  "world_setting",
  "first_message",
];
const ADULT_MIN_AGE = 20;
const MAX_IMAGES = 100;
const size = (value: string) => Array.from(value).length;
const invalid = (...fields: [string, string][]) =>
  new ApiError(
    "invalid_input",
    422,
    fields.map(([field, reason]) => ({ field, reason })),
  );
function creator(state: State) {
  const user = account(state);
  if (user.is_guest) throw new ApiError("member_required", 403);
  return user;
}
function owned(state: State, characterId: string) {
  const user = creator(state);
  const found = state.characters?.find(
    (value) => value.id === characterId && !value.deleted,
  );
  if (!found) throw new ApiError("character_not_found", 404);
  if (found.owner_id !== user.account_id) throw new ApiError("not_owner", 403);
  return found;
}
function detail(character: StoredCharacter) {
  const text = (key: string) => character.texts[key] || null;
  return {
    id: character.id,
    status: character.status,
    revision_status: null,
    rejection_reason: character.rejection_reason,
    name: text("name"),
    character_name: text("character_name"),
    tagline: text("tagline"),
    personality: text("personality"),
    speech_style: text("speech_style"),
    world_setting: text("world_setting"),
    first_message: text("first_message"),
    status_window_enabled: character.status_window_enabled,
    status_window_format: text("status_window_format"),
    status_window_initial: text("status_window_initial"),
    status_window_rules: text("status_window_rules"),
    gender: character.gender,
    age: character.age,
    is_adult: character.is_adult,
    image_url: character.image_url,
    images: character.images,
    updated_at: character.updated_at,
  };
}
export function myCharacters(state: State) {
  const user = creator(state);
  return {
    characters: (state.characters ?? [])
      .filter((value) => value.owner_id === user.account_id && !value.deleted)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((value) => ({
        id: value.id,
        name: value.texts.name || null,
        image_url: value.image_url,
        status: value.status,
        revision_status: null,
        rejection_reason: value.rejection_reason,
        updated_at: value.updated_at,
      })),
  };
}
export function characterDetail(state: State, characterId: string) {
  return detail(owned(state, characterId));
}
/** Create ([characterId] null) or update, as the server checks it (CHARACTER 4-1-2). */
export function saveCharacter(
  state: State,
  characterId: string | null,
  fields: Record<string, string>,
  thumbnail?: string,
) {
  const user = creator(state);
  const action = fields.action;
  const errors: [string, string][] = [];
  if (action !== "save" && action !== "submit")
    errors.push(["action", "invalid_value"]);
  const current: StoredCharacter = characterId
    ? owned(state, characterId)
    : {
        id: id(),
        owner_id: user.account_id,
        status: "draft",
        rejection_reason: null,
        texts: {},
        gender: null,
        age: null,
        status_window_enabled: false,
        is_adult: false,
        image_url: null,
        images: [],
        updated_at: "",
        deleted: false,
      };
  const texts = { ...current.texts };
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    if (!(key in fields)) continue;
    texts[key] = fields[key].trim();
    if (size(texts[key]) > limit) errors.push([key, "too_long"]);
  }
  let { gender, age } = current;
  if ("gender" in fields) {
    const value = fields.gender.trim();
    if (value === "" || value === "female" || value === "male")
      gender = value === "" ? null : value;
    else errors.push(["gender", "invalid_value"]);
  }
  if ("age" in fields) {
    const value = fields.age.trim();
    if (value === "" || /^[0-9]{1,5}$/.test(value))
      age = value === "" ? null : Number(value);
    else errors.push(["age", "invalid_value"]);
  }
  const flag = (key: string, fallback: boolean) => {
    if (!(key in fields)) return fallback;
    if (fields[key] === "true" || fields[key] === "false")
      return fields[key] === "true";
    errors.push([key, "invalid_value"]);
    return fallback;
  };
  const statusWindow = flag(
    "status_window_enabled",
    current.status_window_enabled,
  );
  const isAdult = flag("is_adult", current.is_adult);
  if (errors.length) throw invalid(...errors);
  const submit = action === "submit";
  if (
    !submit &&
    (current.status === "pending" || current.status === "approved")
  )
    throw new ApiError("save_not_allowed", 409);
  if (isAdult && !user.adult_verified)
    throw new ApiError("adult_verification_required", 403);
  if (statusWindow && !texts.status_window_format)
    errors.push(["status_window_format", "required"]);
  if (isAdult && (age === null || age < ADULT_MIN_AGE))
    errors.push(["is_adult", "age_too_low"]);
  const image = thumbnail ?? current.image_url;
  if (submit) {
    for (const key of REQUIRED) if (!texts[key]) errors.push([key, "required"]);
    if (!gender) errors.push(["gender", "required"]);
    if (age === null) errors.push(["age", "required"]);
    if (!image) errors.push(["thumbnail", "required"]);
    if (statusWindow && !texts.status_window_initial)
      errors.push(["status_window_initial", "required"]);
  }
  if (errors.length) throw invalid(...errors);
  Object.assign(current, {
    texts,
    gender,
    age,
    status_window_enabled: statusWindow,
    is_adult: isAdult,
    image_url: image,
    updated_at: new Date().toISOString(),
  });
  if (submit) {
    current.status = "pending";
    current.rejection_reason = null;
  }
  if (!characterId) (state.characters ??= []).push(current);
  return detail(current);
}
export function deleteCharacter(state: State, characterId: string) {
  owned(state, characterId).deleted = true;
}
/** The preview never approves, so a public character with a revision does not exist here. */
export function cancelRevision(state: State, characterId: string) {
  owned(state, characterId);
  throw new ApiError("revision_not_found", 404);
}
function editable(state: State, characterId: string) {
  const character = owned(state, characterId);
  if (character.status === "pending" || character.status === "approved")
    throw new ApiError("save_not_allowed", 409);
  return character;
}
function imageName(value: string | undefined) {
  const name = (value ?? "").trim().replaceAll("\n", " ");
  if (!name) throw invalid(["name", "required"]);
  if (size(name) > 40) throw invalid(["name", "too_long"]);
  return name;
}
function imageDescription(value: string | undefined) {
  const description = (value ?? "").trim();
  if (size(description) > 200) throw invalid(["description", "too_long"]);
  return description;
}
/** Everything but the upload itself, so a refused picture is never read into memory. */
export function checkImage(
  state: State,
  characterId: string,
  input: { name?: string; description?: string },
) {
  const character = editable(state, characterId);
  const name = imageName(input.name);
  const description = imageDescription(input.description);
  if (character.images.length >= MAX_IMAGES)
    throw new ApiError("image_limit_reached", 409);
  if (character.images.some((value) => value.name === name))
    throw invalid(["name", "duplicate"]);
  return { character, name, description };
}
export function addImage(
  state: State,
  characterId: string,
  input: { name?: string; description?: string; image_url: string },
) {
  const { character, name, description } = checkImage(
    state,
    characterId,
    input,
  );
  const image: StoredImage = {
    id: id(),
    name,
    description,
    image_url: input.image_url,
    position:
      Math.max(-1, ...character.images.map((value) => value.position)) + 1,
  };
  character.images.push(image);
  character.updated_at = new Date().toISOString();
  return image;
}
export function updateImage(
  state: State,
  characterId: string,
  imageId: string,
  input: { name?: string; description?: string },
) {
  const character = editable(state, characterId);
  const image = character.images.find((value) => value.id === imageId);
  if (!image) throw new ApiError("image_not_found", 404);
  const name = input.name === undefined ? image.name : imageName(input.name);
  const description =
    input.description === undefined
      ? image.description
      : imageDescription(input.description);
  if (character.images.some((value) => value !== image && value.name === name))
    throw invalid(["name", "duplicate"]);
  Object.assign(image, { name, description });
  character.updated_at = new Date().toISOString();
  return image;
}
export function deleteImage(
  state: State,
  characterId: string,
  imageId: string,
) {
  const character = editable(state, characterId);
  if (!character.images.some((value) => value.id === imageId))
    throw new ApiError("image_not_found", 404);
  character.images = character.images.filter((value) => value.id !== imageId);
  character.updated_at = new Date().toISOString();
}
