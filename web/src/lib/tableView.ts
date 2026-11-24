import type { Address, Hex } from "viem";

import { NO_SEAT, Phase } from "@/chain/reads";
import { BID_TIMEOUT_SECONDS, PROOF_TIMEOUT_SECONDS } from "@/config/game";

import { smallestLegalBid } from "./bidRules";

/**
 * E5 table view, pure parts: which actions each viewer may take, the deadline ring, the push result mapping,
 * the gas note and the settled summary. Time is the browser clock in seconds; the contract decides with
 * block.timestamp, so a button shown a few seconds early only costs a failed simulation (nothing is sent).
 */

// ---- actions ---------------------------------------------------------------------------------------------------

export interface ActionInput {
  readonly phase: number;
  /** The viewer's seat, NO_SEAT for spectators. */
  readonly mySeat: number;
  readonly turnSeat: number;
  readonly playerCount: number;
  /** Current bid (0 / 0 = none yet). */
  readonly bidQuantity: number;
  readonly bidFace: number;
  readonly deadline: bigint;
  readonly nowSeconds: bigint;
  /** A wallet on Sepolia is connected (every action is a transaction). */
  readonly canWrite: boolean;
  /** A write is in flight (TxQueue busy): no second action until it is done. */
  readonly pendingTx: boolean;
}

export interface Actions {
  /** Bid picker: own turn, before the turn deadline, a legal raise exists, nothing pending. */
  readonly bid: boolean;
  /** LIAR!: own turn, before the deadline, a bid exists, nothing pending. */
  readonly liar: boolean;
  /** Why bid / LIAR! are not available (null when bid is available). */
  readonly reason: string | null;
  /** "No bid to challenge yet" exactly when no bid exists. */
  readonly liarReason: string | null;
  /** claimTurnTimeout: anyone, after the turn deadline. */
  readonly claimTimeout: boolean;
  /** "Deal the dice" (startGame push): anyone, while AwaitingPaidProof (accepted after the deadline too, until cancel). */
  readonly deal: boolean;
  /** "Reveal the dice" (finalizeReveal push): anyone, while AwaitingReveal. */
  readonly reveal: boolean;
  /** Waiting for the player on turn (words instead of buttons). */
  readonly waitingForTurn: boolean;
}

export const NO_BID_TO_CHALLENGE = "No bid to challenge yet";

export function tableActions(input: ActionInput): Actions {
  const { phase, mySeat, turnSeat, playerCount, bidQuantity, bidFace, deadline, nowSeconds, canWrite, pendingTx } =
    input;
  const bidding = phase === Phase.Bidding;
  const beforeDeadline = nowSeconds <= deadline; // the contract: TurnExpired when block.timestamp > deadline
  const seated = mySeat !== NO_SEAT;
  const myTurn = bidding && seated && mySeat === turnSeat && beforeDeadline;
  const canRaise = smallestLegalBid({ playerCount, prevQuantity: bidQuantity, prevFace: bidFace }) !== null;
  const hasBid = bidQuantity > 0;
  // RV-8: before the first clock tick (nowSeconds 0 during the first render) no time-based action is offered.
  const clockKnown = nowSeconds > 0n;
  const actNow = canWrite && myTurn && !pendingTx && clockKnown;

  let reason: string | null = null;
  if (!bidding) reason = "Bids happen only while the table is bidding.";
  else if (!clockKnown) reason = "Reading the clock…";
  else if (!canWrite) reason = "Connect a wallet on Sepolia to play.";
  else if (!seated) reason = "You are watching this table.";
  else if (!beforeDeadline) reason = "The turn time ran out.";
  else if (mySeat !== turnSeat) reason = "Not your turn.";
  else if (pendingTx) reason = "Wait for your pending transaction.";
  else if (!canRaise) reason = "No higher bid is possible: call LIAR!";

  return {
    bid: actNow && canRaise,
    liar: actNow && hasBid,
    reason,
    liarReason: hasBid ? (actNow ? null : reason) : NO_BID_TO_CHALLENGE,
    claimTimeout: canWrite && bidding && clockKnown && !beforeDeadline,
    deal: canWrite && phase === Phase.AwaitingPaidProof,
    reveal: canWrite && phase === Phase.AwaitingReveal,
    waitingForTurn: bidding && beforeDeadline && !myTurn,
  };
}

// ---- deadline ring ---------------------------------------------------------------------------------------------

export interface Ring {
  readonly secondsLeft: number;
  /** Share of the period still left, 0..1 (drives the ring). */
  readonly fraction: number;
  readonly expired: boolean;
  readonly label: string;
}

/** Turn deadline while Bidding (BID_TIMEOUT 300 s), proof deadline while Awaiting* (PROOF_TIMEOUT 1 h). */
export function deadlineRing(phase: number, deadline: bigint, nowSeconds: bigint): Ring | null {
  const period =
    phase === Phase.Bidding
      ? BID_TIMEOUT_SECONDS
      : phase === Phase.AwaitingPaidProof || phase === Phase.AwaitingReveal
        ? PROOF_TIMEOUT_SECONDS
        : null;
  if (period === null || deadline === 0n) return null;
  const left = Number(deadline - nowSeconds);
  const secondsLeft = Math.max(0, left);
  const fraction = Math.min(1, Math.max(0, left / period));
  const expired = left <= 0;
  return { secondsLeft, fraction, expired, label: expired ? TIMES_UP : formatSeconds(secondsLeft) };
}

export const TIMES_UP = "Time's up";

export function formatSeconds(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `${seconds} s`;
}

// ---- push (startGame / finalizeReveal) -------------------------------------------------------------------------

export type PushKind = "deal" | "reveal";

/** Measured on Sepolia (BUILD-LOG Phase D gas table); 3 players is interpolated. */
export function pushGasNote(kind: PushKind, players: number): string {
  const gas =
    kind === "deal"
      ? { 2: "4.6M", 3: "6.7M (estimated)", 4: "8.9M" }[players]
      : { 2: "1.4M", 3: "2.4M (estimated)", 4: "3.3M" }[players];
  return `About ${gas ?? "several million"} gas, paid by you. It moves the game on for everyone.`;
}

/** Zero handles mean "not set yet": never send them to the KMS. */
export function hasZeroHandle(handles: readonly string[]): boolean {
  return handles.some((h) => /^0x0{64}$/i.test(h));
}

// ---- seats -------------------------------------------------------------------------------------------------------

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface SeatRow {
  readonly seat: number;
  /** null for an empty seat. */
  readonly address: Address | null;
  readonly you: boolean;
  /** Only while Bidding. */
  readonly turn: boolean;
  /** "own"/"cipher" only for occupied seats while Bidding or AwaitingReveal. */
  readonly dice: "own" | "cipher" | "none";
}

/** E5-R1/R3: one row per seat (0..maxPlayers-1), in seat order. Pure. */
export function seatRows(input: {
  readonly players: readonly string[];
  readonly maxPlayers: number;
  readonly phase: number;
  readonly turnSeat: number;
  readonly viewer: Address | undefined;
}): SeatRow[] {
  const diceShown = input.phase === Phase.Bidding || input.phase === Phase.AwaitingReveal;
  return Array.from({ length: input.maxPlayers }, (_, seat) => {
    const raw = input.players[seat];
    const address = raw && raw.toLowerCase() !== ZERO_ADDRESS ? (raw as Address) : null;
    const you = address !== null && input.viewer !== undefined && address.toLowerCase() === input.viewer.toLowerCase();
    return {
      seat,
      address,
      you,
      turn: input.phase === Phase.Bidding && input.turnSeat === seat && address !== null,
      dice: address === null || !diceShown ? "none" : you ? "own" : "cipher",
    };
  });
}

const ZERO_HANDLE_RE = /^0x0{64}$/i;

/** E5-R2/R3: the decrypt request: only the viewer's own non-zero handles; nothing for spectators. Pure. */
export function ownDiceDecryptItems(input: {
  readonly viewerSeat: number;
  readonly handles: readonly Hex[] | undefined;
  readonly contract: Address;
}): { handle: Hex; contract: Address }[] {
  if (input.viewerSeat === NO_SEAT || !input.handles) return [];
  return input.handles.filter((h) => !ZERO_HANDLE_RE.test(h)).map((handle) => ({ handle, contract: input.contract }));
}

export type OwnDiceView =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "faces"; readonly faces: number[] }
  | { readonly kind: "error"; readonly message: string };

/** E5-R2: what the own-dice row shows. A value outside 1..6 is an error (never a raw handle). Pure. */
export function ownDiceView(input: {
  readonly seated: boolean;
  readonly handles: readonly Hex[] | undefined;
  readonly values: ReadonlyMap<string, bigint> | undefined;
}): OwnDiceView {
  if (!input.seated) return { kind: "none" };
  if (!input.handles || !input.values) return { kind: "loading" };
  const faces: number[] = [];
  for (const handle of input.handles) {
    const value = input.values.get(handle) ?? input.values.get(handle.toLowerCase());
    if (value === undefined) return { kind: "loading" };
    if (value < 1n || value > 6n) {
      return { kind: "error", message: "A decrypted die was not between 1 and 6. Press Retry." };
    }
    faces.push(Number(value));
  }
  return { kind: "faces", faces };
}

/** E5-R15: the own-dice cache key, different per account, so dice are never shared across accounts. */
export function ownDiceQueryKey(tableId: bigint, player: Address, round: number): readonly string[] {
  return ["own-dice", tableId.toString(), player.toLowerCase(), String(round)];
}

/** RV-4: the deal happened for this seat: exactly five dice handles, none bytes32(0). */
export function diceDealt(handles: readonly string[] | undefined): boolean {
  return handles !== undefined && handles.length === 5 && !handles.some((h) => ZERO_HANDLE_RE.test(h));
}

/** Paid state per seat. Never "no chips": public token history cannot tell, and the flag stays hidden. */
export function paidLabel(phase: number): string {
  if (phase === Phase.Joining) return "Stake: hidden until the table is full";
  if (phase === Phase.AwaitingPaidProof) return "Stake: being checked by the KMS";
  if (phase === Phase.Cancelled) return "Stake: refunded";
  return "Stake: verified";
}

// ---- settled -----------------------------------------------------------------------------------------------------

export interface SettledInput {
  readonly liarCallerSeat: number;
  readonly bidderSeat: number;
  readonly loserSeat: number;
  readonly revealedCount: number;
  readonly bidQuantity: number;
  readonly bidFace: number;
}

export type SettledSummary =
  | { readonly kind: "revealed"; readonly loserSeat: number; readonly bidTrue: boolean; readonly text: string }
  | { readonly kind: "timeout"; readonly loserSeat: number; readonly text: string }
  | { readonly kind: "unknown" };

/** A short factual result from the contract's own state (works even when event history is unavailable). */
export function settledSummary(s: SettledInput, seatName: (seat: number) => string): SettledSummary {
  if (s.loserSeat === NO_SEAT) return { kind: "unknown" };
  if (s.liarCallerSeat === NO_SEAT) {
    return {
      kind: "timeout",
      loserSeat: s.loserSeat,
      text: `${seatName(s.loserSeat)} ran out of time and lost. The dice were never revealed and stay encrypted.`,
    };
  }
  const bidTrue = s.revealedCount >= s.bidQuantity;
  return {
    kind: "revealed",
    loserSeat: s.loserSeat,
    bidTrue,
    text: `Bid: ${s.bidQuantity} × ${s.bidFace}. ${s.revealedCount} ${s.revealedCount === 1 ? "die shows" : "dice show"} ${s.bidFace}, so the bid was ${bidTrue ? "true: the caller" : "false: the bidder"}, ${seatName(s.loserSeat)}, lost.`,
  };
}
