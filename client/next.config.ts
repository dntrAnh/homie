import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  // Revalidate the service worker on every load so an old one is never pinned.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ]
  },
}

export default nextConfig
