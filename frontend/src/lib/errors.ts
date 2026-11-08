import { ApiError } from "./contracts";

const messages: Record<string, string> = {
  offline: "common.offline",
  network_error: "common.network_error",
  storage_unavailable: "common.storage_failed",
  account_changed: "common.session_changed",
  session_recovery_failed: "common.session_expired",
  adult_verification_required: "character.adult_verification_required",
  adult_mode_unavailable: "character.adult_mode_unavailable",
  nickname_taken: "account.me.nickname_taken",
  photo_type_invalid: "account.me.photo_type_invalid",
  file_too_large: "account.me.photo_large",
  generation_in_progress: "chat.generation_in_progress",
  room_not_found: "chat.not_found",
  character_not_found: "character.not_found",
};

export function errorMessageKey(error: unknown, fallback = "common.action_failed"): string {
  if (!(error instanceof ApiError)) return fallback;
  if (Object.hasOwn(messages, error.code)) return messages[error.code];
  if (error.status === 401) return "common.session_expired";
  if (error.status === 403) return "common.forbidden";
  if (error.status === 404) return "common.not_found";
  if (error.status === 413) return "account.me.photo_large";
  if (error.status === 422) {
    const fields = Array.isArray(error.detail) ? error.detail : [];
    if (fields.some((item) => item?.field === "client_message_id"))
      return "chat.message_conflict";
    if (fields.some((item) => item?.field === "nickname"))
      return "account.me.nickname_invalid";
    if (fields.some((item) => item?.field === "photo"))
      return "account.me.photo_type_invalid";
    return "common.invalid_input";
  }
  if (error.status === 429) return "common.too_many_requests";
  if (error.status >= 500) return "common.server_error";
  return fallback;
}
