import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/ingest/[...path]/route";

afterEach(() => vi.unstubAllGlobals());

function capture() {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      return new Response('{"status":1}', {
        headers: { "content-type": "application/json", "set-cookie": "x=1" },
      });
    }),
  );
  return calls;
}

describe("/ingest proxy", () => {
  it("forwards to PostHog with the visitor IP and without app cookies", async () => {
    const calls = capture();
    const response = await POST(
      new NextRequest("http://127.0.0.1:3000/ingest/e/?compression=gzip-js", {
        method: "POST",
        body: "payload",
        headers: {
          "content-type": "text/plain",
          "x-forwarded-for": "1.34.0.1, 10.0.0.2",
          cookie: "guest_id=secret; session=secret",
          authorization: "Bearer app-session-token",
          "posthog-sdk": "web",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const [call] = calls;
    expect(call.url).toBe("https://us.i.posthog.com/e/?compression=gzip-js");
    expect(call.headers.get("x-forwarded-for")).toBe("1.34.0.1");
    expect(call.headers.get("cookie")).toBeNull();
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("posthog-sdk")).toBe("web");
    expect(call.headers.get("content-type")).toBe("text/plain");
  });

  it("prefers the platform's real IP and routes static files to the asset host", async () => {
    const calls = capture();
    await POST(
      new NextRequest("http://127.0.0.1:3000/ingest/static/array.js", {
        method: "POST",
        headers: {
          "x-real-ip": "1.34.0.9",
          "x-forwarded-for": "6.6.6.6",
          authorization: "Bearer phc_project",
        },
      }),
    );
    expect(calls[0].url).toBe(
      "https://us-assets.i.posthog.com/static/array.js",
    );
    expect(calls[0].headers.get("x-forwarded-for")).toBe("1.34.0.9");
    expect(calls[0].headers.get("authorization")).toBe("Bearer phc_project");
  });
});
