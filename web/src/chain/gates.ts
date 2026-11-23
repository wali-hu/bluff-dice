import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";

/**
 * Sepolia ETH a new player needs for onboarding: claim chips + authorize + join is about 3.0M gas
 * (BUILD-LOG Phase D gas table); 0.005 ETH covers it at the ~1 gwei measured on Sepolia with headroom.
 */
export const MIN_ETH_WEI = 5_000_000_000_000_000n;

export type GateStatus =
  | "checking" // before mount, or while the wallet restores a connection
  | "noWallet"
  | "disconnected"
  | "wrongChain"
  | "noEth"
  | "lowEth"
  | "ready";

export interface GateInput {
  readonly mounted: boolean;
  readonly hasWallet: boolean;
  readonly connection: "connected" | "connecting" | "reconnecting" | "disconnected";
  readonly chainId: number | undefined;
  /** Undefined while loading. */
  readonly balanceWei: bigint | undefined;
}

/** S8: the first blocking problem, in the order a player has to fix them. */
export function gateStatus({ mounted, hasWallet, connection, chainId, balanceWei }: GateInput): GateStatus {
  if (!mounted || connection === "connecting" || connection === "reconnecting") return "checking";
  if (connection === "disconnected") return hasWallet ? "disconnected" : "noWallet";
  if (chainId !== SEPOLIA_CHAIN_ID) return "wrongChain";
  if (balanceWei === undefined) return "checking";
  if (balanceWei === 0n) return "noEth";
  if (balanceWei < MIN_ETH_WEI) return "lowEth";
  return "ready";
}
