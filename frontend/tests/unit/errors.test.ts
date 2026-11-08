import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/contracts";
import { errorMessageKey } from "@/lib/errors";
import { locales, text } from "@/i18n";
import { messages } from "@/lib/translations";

describe("localized error guidance", () => {
  it.each([
    ["offline", 0, "common.offline"],
    ["network_error", 0, "common.network_error"],
    ["storage_unavailable", 503, "common.storage_failed"],
    ["unknown", 401, "common.session_expired"],
    ["account_changed", 401, "common.session_changed"],
    ["unknown", 403, "common.forbidden"],
    [
      "adult_verification_required",
      403,
      "character.adult_verification_required",
    ],
    ["unknown", 404, "common.not_found"],
    ["nickname_taken", 409, "account.me.nickname_taken"],
    ["unknown", 413, "account.me.photo_large"],
    ["photo_type_invalid", 422, "account.me.photo_type_invalid"],
    ["invalid_input", 422, "common.invalid_input"],
    ["generation_in_progress", 409, "chat.generation_in_progress"],
    ["room_not_found", 404, "chat.not_found"],
    ["unknown", 429, "common.too_many_requests"],
    ["unknown", 503, "common.server_error"],
    ["toString", 400, "common.action_failed"],
  ])("maps %s (%s) to translated guidance", (code, status, key) => {
    expect(errorMessageKey(new ApiError(code, status))).toBe(key);
    for (const locale of locales)
      expect(text(messages[locale], key)).not.toBe(key);
  });

  it("distinguishes invalid nickname and photo fields in 422 responses", () => {
    expect(
      errorMessageKey(
        new ApiError("invalid_input", 422, [
          { field: "nickname", reason: "too_long" },
        ]),
      ),
    ).toBe("account.me.nickname_invalid");
    expect(
      errorMessageKey(
        new ApiError("invalid_input", 422, [
          { field: "photo", reason: "invalid_type" },
        ]),
      ),
    ).toBe("account.me.photo_type_invalid");
    expect(
      errorMessageKey(new ApiError("invalid_input", 422, [null, "unexpected"])),
    ).toBe("common.invalid_input");
  });

  it("maps a reused message ID with different text to the conflict guidance", () => {
    const key = errorMessageKey(
      new ApiError("invalid_input", 422, [
        { field: "client_message_id", reason: "content_mismatch" },
      ]),
    );
    expect(key).toBe("chat.message_conflict");
    for (const locale of locales)
      expect(text(messages[locale], key)).not.toBe(key);
  });

  it("keeps contextual fallback for unknown errors without showing raw details", () => {
    expect(
      errorMessageKey(new Error("private server details"), "chat.failed"),
    ).toBe("chat.failed");
  });
});
