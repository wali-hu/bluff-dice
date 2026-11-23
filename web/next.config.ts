import type { NextConfig } from "next";

import { FHE_ASSET_CACHE_HEADER, securityHeaders } from "./src/config/csp";
import { DEFAULT_SEPOLIA_RPC_URL, RELAYER_URL, resolveRpcUrl } from "./src/config/rpc";

const headers = securityHeaders({
  // The configured read RPC (inlined into the client bundle at build) and the public fallback.
  rpcUrls: [resolveRpcUrl(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL), DEFAULT_SEPOLIA_RPC_URL],
  relayerUrl: RELAYER_URL,
  dev: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // web/ has its own lockfile inside the contracts repo: pin the workspace root to this folder.
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
  async headers() {
    return [
      { source: "/:path*", headers },
      // Paths carry the SDK version or a content hash (scripts/sync-fhe-assets.mts).
      { source: "/fhe/:path*", headers: [FHE_ASSET_CACHE_HEADER] },
    ];
  },
};

export default nextConfig;
