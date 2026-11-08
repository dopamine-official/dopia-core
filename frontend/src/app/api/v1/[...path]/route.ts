import { SeverityNumber } from "@opentelemetry/api-logs";
import { after, type NextRequest } from "next/server";
import { loggerProvider, posthogLogger } from "../../../../../instrumentation";

export const dynamic = "force-dynamic";

// With API_UPSTREAM set, /api/v1/* is forwarded to the real chat-server (cookies and
// streams included). Without it the in-page mock transport answers and nothing may fall
// through to an external service.
const upstream = process.env.API_UPSTREAM;

function flushPostHogLogs() {
  const provider = loggerProvider;
  if (provider) after(() => provider.forceFlush().catch(() => undefined));
}

function unavailable(request: NextRequest) {
  posthogLogger?.emit({
    body: "API proxy request skipped because no upstream is configured",
    severityNumber: SeverityNumber.WARN,
    attributes: { "http.request.method": request.method },
  });
  flushPostHogLogs();
  return Response.json(
    {
      code: "mock_not_initialized",
      message: "Open the app in a browser to initialize the local API.",
      detail: [],
    },
    { status: 503 },
  );
}

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  if (!upstream) return unavailable(request);
  posthogLogger?.emit({
    body: "API proxy request forwarding to configured upstream",
    severityNumber: SeverityNumber.INFO,
    attributes: { "http.request.method": request.method },
  });
  const { path } = await context.params;
  const target = new URL(`/api/v1/${path.join("/")}`, upstream);
  target.search = request.nextUrl.search;
  const headers = new Headers(request.headers);
  for (const name of ["host", "connection", "content-length", "accept-encoding"])
    headers.delete(name);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // @ts-expect-error Node fetch needs duplex for streamed request bodies.
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  });
  posthogLogger?.emit({
    body: "API proxy received upstream response",
    severityNumber: SeverityNumber.INFO,
    attributes: {
      "http.request.method": request.method,
      "http.response.status_code": response.status,
    },
  });
  flushPostHogLogs();
  const out = new Headers();
  for (const [name, value] of response.headers) {
    if (["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection"].includes(name))
      continue;
    out.set(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(response.status === 204 ? null : response.body, {
    status: response.status,
    headers: out,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
