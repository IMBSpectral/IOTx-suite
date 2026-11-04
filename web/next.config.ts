import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every route here is per-user and session-dependent, so there is nothing
  // for cacheComponents to cache — and it forbids the dynamic segment config
  // those routes need.
  // esbuild, the Postgres driver and playwright-core (view_app) ship native
  // binaries or browser downloads; bundling them into
  // the server build breaks on the platform-specific files.
  serverExternalPackages: ["esbuild", "isomorphic-git", "pg", "@prisma/client", "playwright-core"],
  experimental: {
    // proxy.ts runs on every request, and Next caps bodies passing through it at 10 MB:
    // Files uploads go up to 2 GB (lib/files.ts checks the real limits).
    proxyClientMaxBodySize: "2gb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Local dev only: in production Caddy sends /workspace* to apps/workspace.
  // With WORKSPACE_DEV_PROXY=http://localhost:3100 (read at build time) this
  // server forwards /workspace* there, so Calendar, Tasks and Chat open on
  // the suite's own origin exactly as they do live.
  async rewrites() {
    const to = (process.env.WORKSPACE_DEV_PROXY ?? "").replace(/\/$/, "");
    return to ? [{ source: "/workspace", destination: `${to}/workspace` }, { source: "/workspace/:path*", destination: `${to}/workspace/:path*` }] : [];
  },
};

export default nextConfig;
