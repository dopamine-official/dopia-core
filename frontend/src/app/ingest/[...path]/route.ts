import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// Same-origin path for PostHog (src/lib/analytics.ts) so ad blockers do not drop events.
// A route handler instead of a rewrite so the request to PostHog carries the visitor's IP
// (geolocation) and none of this app's cookies.
const API_HOST = "us.i.posthog.com";
const ASSET_HOST = "us-assets.i.posthog.com";
const FORWARDED = ["content-type", "content-encoding", "user-agent"];

/** The visitor's IP as the hosting platform reports it. */
function clientIp(request: NextRequest): string | null {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : null;
}

async function proxy(request: NextRequest) {
  // Keep the exact path, trailing slash included: PostHog's endpoints end in "/".
  const path = request.nextUrl.pathname.replace(/^\/ingest/, "");
  const host = path.startsWith("/static/") ? ASSET_HOST : API_HOST;
  const target = new URL(`https://${host}${path}`);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARDED.includes(name) || name.startsWith("posthog-"))
      headers.set(name, value);
  }
  const authorization = request.headers.get("authorization");
  if (authorization && /^Bearer ph[csx]_/.test(authorization))
    headers.set("authorization", authorization);
  const ip = clientIp(request);
  if (ip) headers.set("x-forwarded-for", ip);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  });
  const out = new Headers();
  for (const [name, value] of response.headers) {
    if (
      [
        "set-cookie",
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
      ].includes(name)
    )
      continue;
    out.set(name, value);
  }
  return new Response(response.status === 204 ? null : response.body, {
    status: response.status,
    headers: out,
  });
}

export const GET = proxy;
export const POST = proxy;
export const OPTIONS = proxy;
