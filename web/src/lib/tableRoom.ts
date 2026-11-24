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
    case Phase.Cancelled:
      return { kind: "over", text: "This table is over: the results view arrives in the next update." };
    default:
      return { kind: "notFound" };
  }
}
