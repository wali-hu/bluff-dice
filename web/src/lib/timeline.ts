import type { Address, Hex } from "viem";

import type { GameLog } from "@/chain/logs";
import { Phase } from "@/chain/reads";
import { BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

/** One table's story from its BluffDice events (all carry `tableId` as the first indexed topic). */
export interface BidEntry {
  readonly bidder: Address;
  readonly quantity: number;
  readonly face: number;
  readonly blockNumber: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
}

export interface Timeline {
  /** TableCreated was found: the history is complete. */
  readonly complete: boolean;
  readonly createdBlock: bigint | undefined;
  readonly gameStartedBlock: bigint | undefined;
  /** Tx hash that started each phase, when known. */
  readonly phaseTx: Readonly<Partial<Record<number, Hex>>>;
  /** Newest first. */
  readonly bids: readonly BidEntry[];
  readonly winnings: readonly { readonly winner: Address; readonly amount: bigint }[];
}

function sameTable(log: GameLog, tableId: bigint): boolean {
  return "tableId" in log.args && (log.args as { tableId: bigint }).tableId === tableId;
}

/**
 * Builds the timeline from decoded logs in chain order. Pure. Only logs emitted by BluffDice count (a
 * look-alike event from another address is not history), each log once (transactionHash + logIndex), and only
 * the given round's bids (E5-R9).
 */
export function buildTimeline(logs: readonly GameLog[], tableId: bigint, round: number): Timeline {
  const seen = new Set<string>();
  let createdBlock: bigint | undefined;
  let gameStartedBlock: bigint | undefined;
  const phaseTx: Partial<Record<number, Hex>> = {};
  const bids: BidEntry[] = [];
  const winnings: { winner: Address; amount: bigint }[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== BLUFF_DICE_ADDRESS.toLowerCase() || !sameTable(log, tableId)) continue;
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    switch (log.eventName) {
      case "TableCreated":
        createdBlock = log.blockNumber;
        phaseTx[Phase.Joining] = log.transactionHash;
        break;
      case "PaidCheckRequested":
        phaseTx[Phase.AwaitingPaidProof] = log.transactionHash;
        break;
      case "GameStarted":
        gameStartedBlock = log.blockNumber;
        phaseTx[Phase.Bidding] = log.transactionHash;
        break;
      case "BidPlaced":
        if (log.args.round !== round) break;
        bids.push({
          bidder: log.args.bidder,
          quantity: log.args.quantity,
          face: log.args.face,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        });
        break;
      case "LiarCalled":
        phaseTx[Phase.AwaitingReveal] = log.transactionHash;
        break;
      case "RoundRevealed":
      case "TurnTimedOut":
        phaseTx[Phase.Settled] = log.transactionHash;
        break;
      case "WinningsPaid":
        if (log.args.round !== round) break;
        winnings.push({ winner: log.args.winner, amount: log.args.amount });
        break;
      case "TableCancelled":
        phaseTx[Phase.Cancelled] = log.transactionHash;
        break;
      default:
        break;
    }
  }
  return {
    complete: createdBlock !== undefined,
    createdBlock,
    gameStartedBlock,
    phaseTx,
    bids: bids.reverse(),
    winnings,
  };
}

export type HistoryView =
  | { readonly kind: "full"; readonly bids: readonly BidEntry[] }
  | {
      readonly kind: "degraded";
      /** The current bid from the contract (getTable), null when nobody has bid yet. */
      readonly current: { readonly quantity: number; readonly face: number; readonly bidderSeat: number } | null;
    };

/**
 * Full history when the logs reach back to the deal (GameStarted) or the table's creation; otherwise (old table,
 * pruned RPC history, read error) the current bid straight from the contract. Pure.
 */
export function historyView(
  timeline: Timeline | null,
  table: { readonly bidQuantity: number; readonly bidFace: number; readonly bidderSeat: number },
): HistoryView {
  if (timeline && (timeline.complete || timeline.gameStartedBlock !== undefined)) {
    return { kind: "full", bids: timeline.bids };
  }
  return {
    kind: "degraded",
    current:
      table.bidQuantity > 0 ? { quantity: table.bidQuantity, face: table.bidFace, bidderSeat: table.bidderSeat } : null,
  };
}
