import path from "node:path";
import type { NextConfig } from "next";
// pnpm links packages from the workspace root, so Turbopack must resolve from there.
const workspaceRoot = path.join(import.meta.dirname, "..");
const config: NextConfig = {
  // `page.e2e.tsx` screens exist only for e2e runs on the dev server, never in a build.
  pageExtensions:
    process.env.NODE_ENV === "production"
      ? ["tsx", "ts", "jsx", "js"]
      : ["tsx", "ts", "jsx", "js", "e2e.tsx"],
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  reactStrictMode: true,
  devIndicators: false,
  // PostHog's endpoints end in a slash; /ingest must reach its route handler as sent.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    // Photos stored by the local chat-server are served through the same origin.
    const upstream = process.env.API_UPSTREAM;
    return upstream
      ? [{ source: "/files/:path*", destination: `${upstream}/files/:path*` }]
      : [];
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
