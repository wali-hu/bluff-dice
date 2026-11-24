import type { Address } from "viem";

import { NO_SEAT, Phase, type TableView } from "@/chain/reads";

import { DEFAULT_PLAYERS, DEFAULT_STAKE } from "./stakes";

export interface TableEntry {
  readonly id: bigint;
  readonly table: TableView;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function same(a: string | undefined | null, b: string | undefined | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export function seatOfIn(table: TableView, player: Address | undefined): number {
  if (!player) return NO_SEAT;
  const seat = table.players.findIndex((p) => same(p, player));
  return seat === -1 ? NO_SEAT : seat;
}

export function isOpen(table: TableView): boolean {
  return table.phase === Phase.Joining && table.playerCount < table.maxPlayers;
}

export function isFinished(table: TableView): boolean {
  return table.phase === Phase.Settled || table.phase === Phase.Cancelled;
}

export function hasSeatedPlayer(table: TableView, player: Address | null): boolean {
  return player !== null && table.players.some((p) => p !== ZERO && same(p, player));
}

export interface LobbyGroups {
  /** Joining with a free seat, that the viewer is not seated at. Newest first. */
  readonly open: TableEntry[];
  /** Tables the viewer is seated at and that are not over. Newest first. */
  readonly mine: TableEntry[];
  /** Settled or cancelled, newest first, at most `finishedLimit`. */
  readonly finished: TableEntry[];
}

/** Groups the lobby batch (newest 50 ids). Pure. */
export function groupTables(
  entries: readonly TableEntry[],
  viewer: Address | undefined,
  finishedLimit = 8,
): LobbyGroups {
  const newest = [...entries].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
  const mine = newest.filter((e) => seatOfIn(e.table, viewer) !== NO_SEAT && !isFinished(e.table));
  const open = newest.filter((e) => isOpen(e.table) && seatOfIn(e.table, viewer) === NO_SEAT);
  const finished = newest.filter((e) => isFinished(e.table)).slice(0, finishedLimit);
  return { open, mine, finished };
}

export interface QuickPlayCandidate {
  readonly id: bigint;
  readonly createdBlock: bigint;
  readonly creator: Address;
}

/**
 * Quick play target: the NEWEST table created at or after `minBlock` (about the last 15 min) that is still open,
 * at the default stake and player count, not created by the bot, not one the viewer sits at or was dropped from.
 * Undefined -> create a new 2-player, 60-chip table. Pure.
 */
export function pickQuickPlay(
  candidates: readonly QuickPlayCandidate[],
  tables: ReadonlyMap<bigint, TableView>,
  options: { viewer: Address; bot: Address | null; minBlock: bigint; droppedIds?: ReadonlySet<bigint> },
): bigint | undefined {
  const sorted = [...candidates].sort((a, b) =>
    a.createdBlock > b.createdBlock ? -1 : a.createdBlock < b.createdBlock ? 1 : 0,
  );
  for (const c of sorted) {
    if (c.createdBlock < options.minBlock) continue;
    if (options.bot && same(c.creator, options.bot)) continue;
    if (options.droppedIds?.has(c.id)) continue;
    const table = tables.get(c.id);
    if (!table || !isOpen(table)) continue;
    if (table.stake !== DEFAULT_STAKE || table.maxPlayers !== DEFAULT_PLAYERS) continue;
    if (seatOfIn(table, options.viewer) !== NO_SEAT) continue;
    if (options.bot && hasSeatedPlayer(table, options.bot)) continue;
    return c.id;
  }
  return undefined;
}

/**
 * The bot's joinable table from a batch of tables: bot at seat 0 (it created it), Joining, a free seat, and the
 * viewer not dropped from it. Newest first. Pure.
 */
export function pickBotTable(
  entries: readonly TableEntry[],
  bot: Address | null,
  droppedIds: ReadonlySet<bigint> = new Set(),
): bigint | undefined {
  if (!bot) return undefined;
  const newest = [...entries].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
  return newest.find((e) => same(e.table.players[0], bot) && isOpen(e.table) && !droppedIds.has(e.id))?.id;
}
