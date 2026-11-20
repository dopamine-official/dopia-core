import { describe, expect, it } from "vitest";
import {
  markStatusChanges,
  splitStatusWindow,
  visibleWhileStreaming,
} from "@/lib/status-window";

describe("status window", () => {
  it("takes the block out of the message and returns its text", () => {
    expect(
      splitStatusWindow(
        '*웃는다.*\n"왔네."\n<status>\n관계: 1단계\n호감도: *12*\n</status>',
      ),
    ).toEqual({
      body: '*웃는다.*\n"왔네."',
      status: "관계: 1단계\n호감도: *12*",
    });
  });
  it("has no status when the message has no block", () => {
    expect(splitStatusWindow("안녕")).toEqual({ body: "안녕", status: null });
    expect(splitStatusWindow("a\n<status>\n \n</status>")).toEqual({
      body: "a",
      status: null,
    });
  });
  it("shows only the last block when there are several", () => {
    expect(
      splitStatusWindow("a\n<status>one</status>\nb\n<status>two</status>"),
    ).toEqual({ body: "a\n\nb", status: "two" });
  });
  it("shows nothing of a block that never closes", () => {
    expect(splitStatusWindow("a\n<status>\n관계: 1단계")).toEqual({
      body: "a",
      status: null,
    });
    expect(
      splitStatusWindow("a\n<status>one</status>\nb\n<status>two"),
    ).toEqual({ body: "a\n\nb", status: "one" });
  });
  it("keeps a tag the character only mentions as ordinary text", () => {
    expect(
      splitStatusWindow(
        '"<status>가 뭐야?" 하고 묻는다.\n<status>\n관계: 1단계\n</status>',
      ),
    ).toEqual({
      body: '"<status>가 뭐야?" 하고 묻는다.',
      status: "관계: 1단계",
    });
  });
  it("leaves a code block before the status window intact", () => {
    expect(
      splitStatusWindow(
        "보여줄게.\n```js\nconsole.log(1)\n```\n<status>\n관계: 1단계\n</status>",
      ),
    ).toEqual({
      body: "보여줄게.\n```js\nconsole.log(1)\n```",
      status: "관계: 1단계",
    });
  });
  it("drops a fence the model opened around the block and never closed", () => {
    expect(
      splitStatusWindow("안녕\n```\n<status>\n관계: 1단계\n</status>"),
    ).toEqual({ body: "안녕", status: "관계: 1단계" });
  });
  // The same reply, with the tags written the ways a model may write them.
  const body = '*웃는다.*\n"왔네."';
  const variants = [
    "<status>\n관계: 1단계\n</status>",
    "<Status>\n관계: 1단계\n</STATUS>",
    "< status >\n관계: 1단계\n</ status >",
    "`<status>`\n관계: 1단계\n`</status>`",
    "```\n<status>\n관계: 1단계\n</status>\n```",
    "```xml\n<status>\n관계: 1단계\n</status>\n```",
  ];
  it.each(variants)(
    "reads the block however the tags are written: %j",
    (block) => {
      expect(splitStatusWindow(`${body}\n${block}`)).toEqual({
        body,
        status: "관계: 1단계",
      });
    },
  );
  it.each(variants)(
    "never lets the block appear while the reply streams: %j",
    (block) => {
      const reply = `${body}\n${block}`;
      for (let length = 0; length <= reply.length; length++) {
        const shown = visibleWhileStreaming(reply.slice(0, length));
        expect(body.startsWith(shown)).toBe(true);
      }
      expect(visibleWhileStreaming(reply)).toBe(body);
    },
  );
  it("holds back only an ending that could become the tag", () => {
    expect(visibleWhileStreaming("a < b")).toBe("a < b");
    expect(visibleWhileStreaming("a <")).toBe("a");
    expect(visibleWhileStreaming("a <sta")).toBe("a");
    expect(visibleWhileStreaming("a <strong")).toBe("a <strong");
    expect(visibleWhileStreaming("a <STA")).toBe("a");
    expect(visibleWhileStreaming("a `")).toBe("a");
    // A closing backtick is held only until the next text shows it was not a wrapper.
    expect(visibleWhileStreaming("a `b`")).toBe("a `b");
    expect(visibleWhileStreaming("a `b` c")).toBe("a `b` c");
    expect(splitStatusWindow("a `b`").body).toBe("a `b`");
    expect(visibleWhileStreaming("a ```\n")).toBe("a");
    expect(visibleWhileStreaming("a ```\ncode")).toBe("a ```\ncode");
  });
});
describe("status changes", () => {
  it("marks each amount that went up or down", () => {
    expect(
      markStatusChanges(
        "관계: 1단계\n호감도: 40\n신뢰: 10%\n장소: 서점",
        "관계: 2단계\n호감도: 45\n신뢰: 7%\n장소: 카페",
      ),
    ).toBe("관계: 2단계 (+1)\n호감도: 45 (+5)\n신뢰: 7% (-3%)\n장소: 카페");
  });
  it("leaves unchanged and uncomparable lines alone", () => {
    expect(
      markStatusChanges(
        "호감도: 40\n체력: 120/200\n돈: 3%\n**기분**: 좋음",
        "호감도: 40\n체력: 100/200\n돈: 5\n**기분**: 나쁨\n새 항목: 3",
      ),
    ).toBe("호감도: 40\n체력: 100/200\n돈: 5\n**기분**: 나쁨\n새 항목: 3");
  });
  it("compares labels without emphasis and keeps decimals clean", () => {
    expect(markStatusChanges("**호감도**: 0.1", "호감도: *0.3*")).toBe(
      "호감도: *0.3* (+0.2)",
    );
  });
  it("compares only values that are an amount, not text with a number in it", () => {
    expect(
      markStatusChanges(
        "현위치 : 3층 복도\n속마음 : 3년 만인데 왜 이래\n횟수 : 1회\n시간 : 10시 반",
        "현위치 : 4층 옥상\n속마음 : 5분만 더 있고 싶다\n횟수 : 2회\n시간 : 11시 반",
      ),
    ).toBe(
      "현위치 : 4층 옥상\n속마음 : 5분만 더 있고 싶다\n횟수 : 2회 (+1)\n시간 : 11시 반",
    );
  });
  it("reads a comma between thousands as grouping", () => {
    expect(
      markStatusChanges("돈: 1,000원\n키: 1,5", "돈: 12,500원\n키: 1,7"),
    ).toBe("돈: 12,500원 (+11,500)\n키: 1,7 (+0.2)");
  });
  it("marks nothing without an earlier window", () => {
    expect(markStatusChanges(null, "호감도: 45")).toBe("호감도: 45");
  });
});
