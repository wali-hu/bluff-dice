import type { Address, PublicClient } from "viem";

import { BOT_ADDRESS, BOT_FROM_BLOCK } from "@/config/bot";
import { BLUFF_DICE_ADDRESS } from "@/contracts/addresses";
import { pickBotTable, pickQuickPlay, type QuickPlayCandidate, type TableEntry } from "@/lib/lobby";

import { decodeGameLogs, scanGameLogs, type GameLog } from "./logs";
import { getDroppedIds, getNextTableId, getTables, newestTableIds, withLagRetry } from "./reads";

/** "Recent" for quick play: tables created in about the last 15 minutes (12 s Sepolia slots). */
export const QUICK_PLAY_WINDOW_BLOCKS = 75n;
/** How many log chunks (50,000 blocks each) the bot fallback scan may read before giving up. */
const BOT_SCAN_MAX_CHUNKS = 20;

/** Lobby batch: the newest `count` tables in one Multicall3 request. */
export async function getLobbyTables(client: PublicClient, count = 50): Promise<TableEntry[]> {
  const next = await getNextTableId(client);
  const tables = await getTables(client, newestTableIds(next, count));
  return [...tables].map(([id, table]) => ({ id, table }));
}

function tableCreatedBy(log: GameLog, creator: Address): boolean {
  return log.eventName === "TableCreated" && log.args.creator.toLowerCase() === creator.toLowerCase();
}

/**
 * The bot's joinable table. First the lobby batch (no logs); else TableCreated logs with creator == bot, newest
 * first, in 50,000-block chunks from BOT_FROM_BLOCK, stopping at the first chunk that yields a joinable table.
 */
export async function findBotTable(
  client: PublicClient,
  viewer: Address | undefined,
  options: { lobby?: readonly TableEntry[]; bot?: Address | null; fromBlock?: bigint } = {},
): Promise<bigint | undefined> {
  const bot = options.bot === undefined ? BOT_ADDRESS : options.bot;
  if (!bot) return undefined;

  const lobby = options.lobby ?? (await getLobbyTables(client));
  const lobbyHit = await pickWithDropped(client, lobby, bot, viewer);
  if (lobbyHit !== undefined) return lobbyHit;

  const head = await withLagRetry(() => client.getBlockNumber({ cacheTime: 0 }));
  const seen = new Set(lobby.map((e) => e.id));
  let chunks = 0;
  for await (const { logs } of scanGameLogs(client, {
    fromBlock: options.fromBlock ?? BOT_FROM_BLOCK,
    toBlock: head,
    newestFirst: true,
  })) {
    const ids = logs
      .filter((log) => tableCreatedBy(log, bot))
      .map((log) => (log.eventName === "TableCreated" ? log.args.tableId : 0n))
      .filter((id) => id > 0n && !seen.has(id));
    if (ids.length > 0) {
      const tables = await getTables(client, ids);
      const hit = await pickWithDropped(
        client,
        [...tables].map(([id, table]) => ({ id, table })),
        bot,
        viewer,
      );
      if (hit !== undefined) return hit;
    }
    if (++chunks >= BOT_SCAN_MAX_CHUNKS) break;
  }
  return undefined;
}

async function pickWithDropped(
  client: PublicClient,
  entries: readonly TableEntry[],
  bot: Address,
  viewer: Address | undefined,
): Promise<bigint | undefined> {
  const first = pickBotTable(entries, bot);
  if (first === undefined || !viewer) return first;
  const candidates = entries.filter((e) => e.table.players[0]?.toLowerCase() === bot.toLowerCase()).map((e) => e.id);
  const dropped = await getDroppedIds(client, candidates, viewer);
  return pickBotTable(entries, bot, dropped);
}

/**
 * Quick play: the newest open 2-player, 60-chip, non-bot table created in the last ~15 minutes (from its
 * TableCreated log), or undefined (the caller creates one).
 */
export async function findQuickPlayTable(
  client: PublicClient,
  viewer: Address,
  bot: Address | null = BOT_ADDRESS,
): Promise<bigint | undefined> {
  const head = await withLagRetry(() => client.getBlockNumber({ cacheTime: 0 }));
  const minBlock = head > QUICK_PLAY_WINDOW_BLOCKS ? head - QUICK_PLAY_WINDOW_BLOCKS : 0n;
  const candidates: QuickPlayCandidate[] = [];
  for await (const { logs } of scanGameLogs(client, { fromBlock: minBlock, toBlock: head })) {
    for (const log of logs) {
      if (log.eventName === "TableCreated") {
        candidates.push({ id: log.args.tableId, createdBlock: log.blockNumber, creator: log.args.creator });
      }
    }
  }
  if (candidates.length === 0) return undefined;
  const ids = candidates.map((c) => c.id);
  const [tables, droppedIds] = await Promise.all([getTables(client, ids), getDroppedIds(client, ids, viewer)]);
  return pickQuickPlay(candidates, tables, { viewer, bot, minBlock, droppedIds });
}

/** The new table id from a createTable receipt (its TableCreated log), or undefined. */
export function tableIdFromReceipt(receipt: { logs: readonly unknown[] }): bigint | undefined {
  const own = (receipt.logs as { address?: string }[]).filter(
    (log) => log.address?.toLowerCase() === BLUFF_DICE_ADDRESS.toLowerCase(),
  );
  const created = decodeGameLogs(own as never).find((log) => log.eventName === "TableCreated");
  return created?.eventName === "TableCreated" ? created.args.tableId : undefined;
}
