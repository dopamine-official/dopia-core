import type { NextConfig } from "next";
const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
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
