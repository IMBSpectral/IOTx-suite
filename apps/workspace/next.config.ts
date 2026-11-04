import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mounted at https://imbspectral.online/workspace behind the suite's Caddy.
  basePath: "/workspace",
  serverExternalPackages: ["pg", "@prisma/client"],
  // Calendar, Tasks, Chat and Meet show in the suite's tabs (same-origin iframes); no other site
  // may frame them. Public pages (booking, RSVP, /embed) keep their own rules.
  async headers() {
    const self = [
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
    ];
    return ["calendar", "tasks", "chat", "meet"].flatMap((p) => [`/${p}`, `/${p}/:path*`]).map((source) => ({ source, headers: self }));
  },
};

export default nextConfig;
