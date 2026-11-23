import type { Hex } from "viem";

import type { TxError } from "@/lib/errors";

/**
 * One write at a time (global mutex). Sepolia lets an EIP-7702 delegated account (MetaMask smart account) have
 * only ONE pending transaction, and every game step depends on the previous receipt anyway.
 *
 * idle -> simulating -> estimating -> awaitingWallet -> pending -> confirmed | reverted
 * any step -> failed:  user rejected -> idle;  "in-flight transaction limit" -> blocked;  else -> reverted
 */
export type TxState =
  | { readonly status: "idle" }
  | { readonly status: "simulating"; readonly label: string }
  | { readonly status: "estimating"; readonly label: string }
  | { readonly status: "awaitingWallet"; readonly label: string; readonly gas: bigint }
  | { readonly status: "pending"; readonly label: string; readonly hash: Hex }
  | { readonly status: "confirmed"; readonly label: string; readonly hash: Hex; readonly blockNumber: bigint }
  | { readonly status: "reverted"; readonly label: string; readonly hash?: Hex; readonly error: TxError }
  | { readonly status: "blocked"; readonly label: string; readonly error: TxError };

export type TxEvent =
  | { readonly type: "start"; readonly label: string }
  | { readonly type: "simulated" }
  | { readonly type: "estimated"; readonly gas: bigint }
  | { readonly type: "submitted"; readonly hash: Hex }
  | { readonly type: "mined"; readonly blockNumber: bigint; readonly success: boolean }
  | { readonly type: "failed"; readonly error: TxError }
  /** User dismissed a result, or confirmed they cleared the wallet's pending transaction. */
  | { readonly type: "reset" };

export const initialTxState: TxState = { status: "idle" };

/** States in which no other write may start (the mutex is held). */
export function isBusy(state: TxState): boolean {
  return (
    state.status === "simulating" ||
    state.status === "estimating" ||
    state.status === "awaitingWallet" ||
    state.status === "pending" ||
    state.status === "blocked"
  );
}

/** Words for a disabled write button. */
export function busyReason(state: TxState): string | null {
  switch (state.status) {
    case "simulating":
    case "estimating":
      return `Preparing "${state.label}"…`;
    case "awaitingWallet":
      return `Confirm "${state.label}" in your wallet.`;
    case "pending":
      return `Waiting for "${state.label}" to be mined (usually about 12 s).`;
    case "blocked":
      return "Finish or cancel the pending transaction in your wallet first.";
    default:
      return null;
  }
}

export function txReducer(state: TxState, event: TxEvent): TxState {
  switch (event.type) {
    case "start":
      return isBusy(state) ? state : { status: "simulating", label: event.label };
    case "simulated":
      return state.status === "simulating" ? { status: "estimating", label: state.label } : state;
    case "estimated":
      return state.status === "estimating" ? { status: "awaitingWallet", label: state.label, gas: event.gas } : state;
    case "submitted":
      return state.status === "awaitingWallet" ? { status: "pending", label: state.label, hash: event.hash } : state;
    case "mined":
      if (state.status !== "pending") return state;
      return event.success
        ? { status: "confirmed", label: state.label, hash: state.hash, blockNumber: event.blockNumber }
        : {
            status: "reverted",
            label: state.label,
            hash: state.hash,
            error: {
              kind: "revertedOnchain",
              message: "The transaction was mined but reverted. The table may have moved on.",
            },
          };
    case "failed": {
      if (
        state.status !== "simulating" &&
        state.status !== "estimating" &&
        state.status !== "awaitingWallet" &&
        state.status !== "pending"
      ) {
        return state;
      }
      const { label } = state;
      const hash = state.status === "pending" ? state.hash : undefined;
      if (event.error.kind === "rejected") return { status: "idle" };
      if (event.error.kind === "inFlightLimit") return { status: "blocked", label, error: event.error };
      return { status: "reverted", label, hash, error: event.error };
    }
    case "reset":
      return state.status === "simulating" ||
        state.status === "estimating" ||
        state.status === "awaitingWallet" ||
        state.status === "pending"
        ? state
        : { status: "idle" };
  }
}

/**
 * Gas limit sent with every write: the node's estimate + 20%, rounded up. Never clamped to 2^24: since
 * Glamsterdam (EIP-8037) state gas is outside the per-tx execution cap and game txs can exceed 2^24 in total.
 */
export function gasWithMargin(estimate: bigint): bigint {
  if (estimate <= 0n) throw new Error("gas estimate must be positive");
  return (estimate * 12n + 9n) / 10n;
}

/** EIP-7702 delegation designator: 0xef0100 || 20-byte delegate address (23 bytes of code). */
export function isEip7702Delegated(code: Hex | undefined): boolean {
  return code !== undefined && /^0xef0100[0-9a-f]{40}$/i.test(code);
}

/**
 * Whether two writes may be sent back to back (the second before the first is mined). Only plain EOAs (no
 * code). Delegated EIP-7702 accounts are limited to one pending tx on Sepolia; other code is not a wallet we
 * support for that. Used later for the onboarding pipeline; the queue itself always runs one write at a time.
 */
export function allowsBackToBackWrites(code: Hex | undefined): boolean {
  return code === undefined || code === "0x";
}
