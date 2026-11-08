import path from "node:path";
import type { NextConfig } from "next";
// pnpm links packages from the workspace root, so Turbopack must resolve from there.
const workspaceRoot = path.join(import.meta.dirname, "..");
const config: NextConfig = {
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  reactStrictMode: true,
  devIndicators: false,
  // PostHog's own paths end in a slash; Next must not redirect them.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    // Analytics go through this origin so ad blockers do not drop them (src/lib/analytics.ts).
    const posthog = [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
    // Photos stored by the local chat-server are served through the same origin.
    const upstream = process.env.API_UPSTREAM;
    return upstream
      ? [
          ...posthog,
          { source: "/files/:path*", destination: `${upstream}/files/:path*` },
        ]
      : posthog;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.r2.dev; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; worker-src 'self' blob:; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'",
          },
        ],
      },
    ];
  },
};
export default config;
