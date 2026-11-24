import type { PublicClient } from "viem";

import { buildTimeline, type Timeline } from "@/lib/timeline";

import { scanGameLogs, type GameLog } from "./logs";
import { withLagRetry } from "./reads";

/** Small, recent requests: wide old ranges are refused by some public RPC backends (code 4444). */
export const TABLE_LOG_SPAN = 1_000n;
/** How far back a table's history is searched (~1 day of 12 s blocks); older games degrade to contract state. */
export const TABLE_LOG_WINDOW = 7_200n;

/**
 * A table's events, newest-first in 1,000-block chunks from the head back to its TableCreated (or the window
 * start); bids of `round` only. `knownFrom` (the TableCreated block from an earlier read) limits refreshes to that block onward.
 */
export async function fetchTableTimeline(
  client: PublicClient,
  tableId: bigint,
  round: number,
  knownFrom?: bigint,
): Promise<Timeline> {
  const head = await withLagRetry(() => client.getBlockNumber({ cacheTime: 0 }));
  const floor = knownFrom ?? (head > TABLE_LOG_WINDOW ? head - TABLE_LOG_WINDOW : 0n);
  const chunks: GameLog[][] = [];
  for await (const { logs } of scanGameLogs(client, {
    fromBlock: floor,
    toBlock: head,
    newestFirst: true,
    span: TABLE_LOG_SPAN,
  })) {
    const mine = logs.filter((log) => "tableId" in log.args && (log.args as { tableId: bigint }).tableId === tableId);
    chunks.unshift(mine);
    if (mine.some((log) => log.eventName === "TableCreated")) break;
  }
  return buildTimeline(chunks.flat(), tableId, round);
}
