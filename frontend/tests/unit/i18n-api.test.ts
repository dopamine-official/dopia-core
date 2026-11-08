import { describe, expect, it } from "vitest";
import { regionConfig, resolveLocale, resolveText, text } from "@/i18n";
import { messages } from "@/lib/translations";
import { readStream, safeReturnTo } from "@/lib/api";
describe("localization and transport", () => {
  it("removes stored Korean preference when the Taiwan profile excludes Korean", () => {
    expect(resolveLocale("ko-KR", regionConfig("TW", "taiwan").locale)).toBe(
      "zh-TW",
    );
    expect(resolveLocale("en-GB", regionConfig("TW", "taiwan").locale)).toBe(
      "en-US",
    );
    expect(resolveLocale(null, regionConfig("TW", "development").locale)).toBe(
      "ko-KR",
    );
  });
  it("resolves localized content and text placeholders", () => {
    expect(
      resolveText(
        { source_locale: "zh-TW", texts: { "zh-TW": "中文" } },
        "ko-KR",
      ),
    ).toBe("中文");
    expect(text(messages["en-US"], "character.start", { name: "Winter" })).toBe(
      "Chat with Winter",
    );
  });
  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/login",
    "/%2f%2fevil.test",
    "javascript:alert(1)",
  ])("rejects unsafe return paths: %s", (value) => {
    expect(safeReturnTo(value)).toBe("/");
  });
  it("keeps an authorized internal return path", () => {
    expect(safeReturnTo("/me")).toBe("/me");
  });
  it("parses fragmented UTF-8 SSE frames and rejects an unterminated stream", async () => {
    const bytes = new TextEncoder().encode(
      'event: token\ndata: {"text":"你好"}\n\nevent: completed\ndata: {"assistant_message_id":"1","content":"你好"}\n\n',
    );
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3)
          controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    const events: string[] = [];
    await readStream(new Response(stream), (value) => events.push(value.event));
    expect(events).toEqual(["token", "completed"]);
    await expect(
      readStream(
        new Response('event: token\ndata: {"text":"partial"}\n\n'),
        () => undefined,
      ),
    ).rejects.toThrow("stream_interrupted");
  });
});
