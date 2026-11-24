import { Phase, type PhaseValue } from "@/chain/reads";

export const PHASE_NAMES: Record<PhaseValue, string> = {
  [Phase.None]: "Not found",
  [Phase.Joining]: "Waiting for players",
  [Phase.AwaitingPaidProof]: "Checking stakes",
  [Phase.Bidding]: "Bidding",
  [Phase.AwaitingReveal]: "Revealing",
  [Phase.Settled]: "Finished",
  [Phase.Cancelled]: "Cancelled",
};

export const CANCELLED_TEXT = "Cancelled: every stake was refunded.";

export type RoomView =
  | { kind: "notFound" }
  | { kind: "waiting" } // full waiting room (seats, invite link, Unlock, Leave/Join)
  | { kind: "checkingStakes"; text: string }
  | { kind: "inProgress"; text: string }
  | { kind: "over"; text: string };

/** What the minimal table page (E4) shows per contract phase. The full table view is E5. Pure. */
export function roomView(phase: number): RoomView {
  switch (phase) {
    case Phase.Joining:
      return { kind: "waiting" };
    case Phase.AwaitingPaidProof:
      return {
        kind: "checkingStakes",
        text: "The table is full. The KMS now decrypts every seat's paid flag (usually 4-10 s) so the contract can check that all stakes arrived before it deals. Sending that proof onchain arrives in the next update.",
      };
    case Phase.Bidding:
    case Phase.AwaitingReveal:
      return { kind: "inProgress", text: "Game in progress: the table view arrives in the next update." };
    case Phase.Settled:
      return {
        kind: "over",
        text: "This round is over. The full result with every die and the proof check arrives in the next update.",
      };
    case Phase.Cancelled:
      return { kind: "over", text: CANCELLED_TEXT };
    default:
      return { kind: "notFound" };
  }
}

/**
 * BluffDice.cancel: allowed in AwaitingPaidProof or AwaitingReveal once `block.timestamp > deadline`
 * (PROOF_TIMEOUT = 1 hour after the phase started). Anyone may call it; every seated player gets back their own
 * stored `transferred` amount (a non-payer gets back their encrypted 0). Pure; `nowSeconds` is the browser clock,
 * so a few seconds early the simulation reverts DeadlineNotPassed and nothing is sent.
 */
export type CancelState =
  | { readonly kind: "none" }
  | { readonly kind: "wait"; readonly deadline: bigint }
  | { readonly kind: "available" };

export function cancelState(phase: number, deadline: bigint, nowSeconds: bigint): CancelState {
  if (phase !== Phase.AwaitingPaidProof && phase !== Phase.AwaitingReveal) return { kind: "none" };
  return nowSeconds > deadline ? { kind: "available" } : { kind: "wait", deadline };
}
