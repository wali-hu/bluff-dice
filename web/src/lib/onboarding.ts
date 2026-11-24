import type { Hex } from "viem";

import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";

export const ONBOARDING_STEPS = ["connect", "network", "claim", "authorize", "join"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The operator grant must still be valid for at least this long when the join is sent. */
export const OPERATOR_MARGIN_SECONDS = 120n;
/** `setOperator(BluffDice, now + 600)`: 10 minutes, in SECONDS (SPEC R3). */
export const OPERATOR_TTL_SECONDS = 600n;
/** OperatorSet logs are looked up in this many recent blocks (~2 h; our grants last 10 min). */
export const OPERATOR_LOG_BLOCKS = 600n;

const ZERO_HANDLE = `0x${"00".repeat(32)}`;

export interface OnboardingReads {
  readonly connected: boolean;
  readonly chainId: number | undefined;
  /** BluffChips.lastFaucet(user): unix seconds, 0 = never claimed on THIS token. */
  readonly lastFaucet: bigint | undefined;
  /** BluffChips.confidentialBalanceOf(user): bytes32(0) = never funded. */
  readonly balanceHandle: Hex | undefined;
  readonly isOperator: boolean | undefined;
  /** `until` of the newest OperatorSet(user, BluffDice) in the last ~600 blocks. */
  readonly operatorUntil: bigint | undefined;
  readonly nowSeconds: bigint;
}

/** Claim is done when this wallet ever claimed here, or holds a funded balance (e.g. owner-minted demo wallets). */
export function hasChips(reads: Pick<OnboardingReads, "lastFaucet" | "balanceHandle">): boolean {
  return (
    (reads.lastFaucet !== undefined && reads.lastFaucet > 0n) ||
    (reads.balanceHandle !== undefined && reads.balanceHandle.toLowerCase() !== ZERO_HANDLE)
  );
}

/** Authorize is done when isOperator AND the newest grant still has >= 120 s left. */
export function operatorReady(reads: Pick<OnboardingReads, "isOperator" | "operatorUntil" | "nowSeconds">): boolean {
  return (
    reads.isOperator === true &&
    reads.operatorUntil !== undefined &&
    reads.operatorUntil >= reads.nowSeconds + OPERATOR_MARGIN_SECONDS
  );
}

/** The step to show, or "loading" while a read it depends on is missing. Pure. */
export function currentStep(reads: OnboardingReads): OnboardingStep | "loading" {
  if (!reads.connected) return "connect";
  if (reads.chainId !== SEPOLIA_CHAIN_ID) return "network";
  if (reads.lastFaucet === undefined || reads.balanceHandle === undefined) return "loading";
  if (!hasChips(reads)) return "claim";
  if (reads.isOperator === undefined) return "loading";
  if (!operatorReady(reads)) return "authorize";
  return "join";
}

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

/** FaucetCooldown: next claim time from lastFaucet (24 h cooldown); undefined when a claim is possible now. */
export function nextFaucetAt(lastFaucet: bigint, nowSeconds: bigint, cooldown = 86_400n): bigint | undefined {
  if (lastFaucet === 0n) return undefined;
  const next = lastFaucet + cooldown;
  return next > nowSeconds ? next : undefined;
}

/** True when a decrypted balance cannot cover the stake (the player would be dropped and banned from the table). */
export function balanceTooLow(balance: bigint | undefined, stake: bigint): boolean {
  return balance !== undefined && balance < stake;
}
