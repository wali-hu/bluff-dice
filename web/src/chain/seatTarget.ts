import type { Address, PublicClient } from "viem";

import { isOpen, seatOfIn, type TableEntry } from "@/lib/lobby";
import type { SeatTarget } from "@/lib/playNow";
import { DEFAULT_PLAYERS, DEFAULT_STAKE } from "@/lib/stakes";

import { findBotTable, findQuickPlayTable } from "./discovery";
import { getDroppedIds, getTable, NO_SEAT } from "./reads";

/** True when `player` can take a seat at `tableId` right now (Joining, a free seat, not seated, not dropped). */
export async function stillJoinable(client: PublicClient, tableId: bigint, player: Address): Promise<boolean> {
  try {
    const [table, dropped] = await Promise.all([getTable(client, tableId), getDroppedIds(client, [tableId], player)]);
    return isOpen(table) && seatOfIn(table, player) === NO_SEAT && !dropped.has(tableId);
  } catch {
    return false;
  }
}

/**
 * Where Play now seats the player (same choice as the manual Join step): the table from ?table=N if still
 * joinable, else the bot's open table, else Quick play (newest recent non-bot 2p/60), else a new 2p/60 table.
 */
export async function chooseSeatTarget(
  client: PublicClient,
  player: Address,
  options: { requested?: bigint; lobby?: readonly TableEntry[]; exclude?: bigint } = {},
): Promise<SeatTarget> {
  if (options.requested !== undefined && options.requested !== options.exclude) {
    if (await stillJoinable(client, options.requested, player)) {
      return { kind: "join", tableId: options.requested, viaBot: false };
    }
  }
  const bot = await findBotTable(client, player, { lobby: options.lobby }).catch(() => undefined);
  if (bot !== undefined && bot !== options.exclude) return { kind: "join", tableId: bot, viaBot: true };
  const quick = await findQuickPlayTable(client, player).catch(() => undefined);
  if (quick !== undefined && quick !== options.exclude) return { kind: "join", tableId: quick, viaBot: false };
  return { kind: "create", stake: DEFAULT_STAKE, players: DEFAULT_PLAYERS };
}
