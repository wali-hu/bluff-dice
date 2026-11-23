import { describe, expect, it } from "vitest";

import { buildCsp, originsOf, securityHeaders } from "./csp";
import { DEFAULT_SEPOLIA_RPC_URL, RELAYER_URL } from "./rpc";

const base = {
  rpcUrls: ["https://rpc.example.org/v3/abc", DEFAULT_SEPOLIA_RPC_URL],
  relayerUrl: RELAYER_URL,
  dev: false,
};

function directive(csp: string, name: string): string[] {
  const part = csp.split("; ").find((d) => d.startsWith(`${name} `));
  return part ? part.split(" ").slice(1) : [];
}

describe("CSP", () => {
  it("allows WASM but not eval in production", () => {
    const script = directive(buildCsp(base), "script-src");
    expect(script).toEqual(["'self'", "'wasm-unsafe-eval'", "'unsafe-inline'"]);
    expect(directive(buildCsp({ ...base, dev: true }), "script-src")).toContain("'unsafe-eval'");
  });

  it("connects only to self, the relayer and the RPC origins (paths and keys dropped)", () => {
    expect(directive(buildCsp(base), "connect-src")).toEqual([
      "'self'",
      "https://relayer.testnet.zama.org",
      "https://rpc.example.org",
      "https://ethereum-sepolia-rpc.publicnode.com",
    ]);
  });

  it("locks down framing, plugins, base and forms", () => {
    const csp = buildCsp(base);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "worker-src")).toEqual(["'self'", "blob:"]);
    expect(directive(csp, "img-src")).toEqual(["'self'", "data:"]);
    expect(csp).not.toContain("cdn.zama.org");
    expect(csp).not.toContain("amazonaws.com");
  });

  it("deduplicates origins and ignores junk", () => {
    expect(originsOf(["https://a.org/x", "https://a.org/y", "not a url", "javascript:alert(1)"])).toEqual([
      "https://a.org",
    ]);
  });

  it("sends nosniff and the other security headers", () => {
    const keys = securityHeaders(base).map((h) => h.key);
    expect(keys).toEqual([
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
    ]);
  });
});
