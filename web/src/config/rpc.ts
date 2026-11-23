/**
 * Network endpoints. No path-alias imports here: next.config.ts imports this file to build the CSP.
 */

/** Public keyless Sepolia RPC used when NEXT_PUBLIC_SEPOLIA_RPC_URL is empty. */
export const DEFAULT_SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

/** Zama testnet relayer (public decrypt, user decrypt). Same value as the SDK's SepoliaConfig.relayerUrl. */
export const RELAYER_URL = "https://relayer.testnet.zama.org";

export function resolveRpcUrl(fromEnv: string | undefined): string {
  return (fromEnv ?? "").trim() || DEFAULT_SEPOLIA_RPC_URL;
}
