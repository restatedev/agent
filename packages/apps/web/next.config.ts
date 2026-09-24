import {join} from "node:path";

import type {NextConfig} from "next";

const dev = process.env.NODE_ENV === "development";

// Everything the UI loads is served by this app. Next.js bootstraps the page
// with inline scripts, which need 'unsafe-inline' without per-request nonces;
// the dev server additionally evals modules and talks HMR over a WebSocket.
// Transcript markdown is escaped before rendering, so this is defence in
// depth, not the only barrier.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "../../.."),
  // TypeScript 7 (native) has no JS compiler API; type-check via its CLI.
  experimental: {useTypeScriptCli: true},
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {key: "Content-Security-Policy", value: contentSecurityPolicy},
          {key: "X-Content-Type-Options", value: "nosniff"},
          {key: "X-Frame-Options", value: "DENY"},
          {key: "Referrer-Policy", value: "no-referrer"},
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default config;
