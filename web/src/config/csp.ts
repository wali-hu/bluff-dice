/**
 * Content Security Policy and security headers for every route. Pure and alias-free: next.config.ts imports it.
 *
 * Why each directive (see securityHeaders() for the full list):
 * - script-src 'self': our JS chunks and the self-hosted relayer SDK UMD (public/fhe/). No CDN.
 *   'wasm-unsafe-eval': WebAssembly.instantiate for the TFHE and KMS WASM; it does NOT allow eval().
 *   'unsafe-inline': Next.js App Router pages embed inline bootstrap scripts (`self.__next_f.push(...)`, the RSC
 *   payload) that differ per page. Nonces would force every page to render per request (no static pages) and
 *   Next 16 has no build-time hash support for these inline scripts, so for static pages 'unsafe-inline' is the
 *   only working option. The exfiltration guard is connect-src / img-src / form-action below.
 *   Development only: 'unsafe-eval' (React dev tooling and fast refresh need it).
 * - worker-src 'self' blob:: the SDK's WASM thread-pool worker (only used if the page is cross-origin isolated).
 * - connect-src: the relayer and our read RPC(s) only. A script that got in cannot fetch() the decryption
 *   session anywhere else. Wallet RPC traffic goes through the extension, not the page.
 * - img-src 'self' data:: wallet icons (EIP-6963 announces them as data: URIs). No remote images.
 * - style-src 'self' 'unsafe-inline': next/font and Next's runtime insert <style> tags.
 * - font-src 'self': next/font self-hosts the fonts at build time.
 * - object-src 'none', base-uri 'self', form-action 'self', frame-ancestors 'none'.
 */
export interface CspOptions {
  /** Read RPC URLs (NEXT_PUBLIC_SEPOLIA_RPC_URL at build + the public fallback). */
  readonly rpcUrls: readonly string[];
  readonly relayerUrl: string;
  readonly dev: boolean;
}

/** "https://host:port" of each URL, deduplicated, invalid entries dropped. */
export function originsOf(urls: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const url of urls) {
    try {
      const { protocol, origin } = new URL(url);
      if (protocol === "https:" || protocol === "http:" || protocol === "wss:" || protocol === "ws:") {
        origins.add(origin);
      }
    } catch {
      // not a URL: ignore
    }
  }
  return [...origins];
}

export function buildCsp({ rpcUrls, relayerUrl, dev }: CspOptions): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'wasm-unsafe-eval'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "worker-src": ["'self'", "blob:"],
    "connect-src": ["'self'", ...originsOf([relayerUrl, ...rpcUrls])],
    "img-src": ["'self'", "data:"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "font-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export function securityHeaders(options: CspOptions): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: buildCsp(options) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    // Allows wallet pop-ups (e.g. browser-extension windows opened by the page) to keep a reference.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  ];
}

/** Versioned / content-hashed FHE assets never change under the same URL. */
export const FHE_ASSET_CACHE_HEADER = { key: "Cache-Control", value: "public, max-age=31536000, immutable" };
