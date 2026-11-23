import { parseEventLogs, type Address, type Log, type PublicClient } from "viem";

import { bluffChipsAbi, bluffDiceAbi } from "@/contracts/abi";
import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

import { isLagError } from "./reads";

/** The public Sepolia RPCs reject getLogs ranges above 50,000 blocks (BUILD-LOG Phase D). */
export const MAX_LOG_SPAN = 50_000n;

export interface BlockRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/** Splits [fromBlock, toBlock] (inclusive) into ranges of at most `span` blocks, oldest or newest first. */
export function chunkRanges(
  fromBlock: bigint,
  toBlock: bigint,
  { span = MAX_LOG_SPAN, newestFirst = false }: { span?: bigint; newestFirst?: boolean } = {},
): BlockRange[] {
  if (span <= 0n) throw new Error("span must be positive");
  if (toBlock < fromBlock) return [];
  const ranges: BlockRange[] = [];
  for (let start = fromBlock; start <= toBlock; start += span) {
    const end = start + span - 1n < toBlock ? start + span - 1n : toBlock;
    ranges.push({ fromBlock: start, toBlock: end });
  }
  return newestFirst ? ranges.reverse() : ranges;
}

const RANGE_TOO_LARGE_RE = /range|too many|limit exceeded|query returned more than|response size/i;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RawLog = Log<bigint, number, false>;

/**
 * Raw logs of one range. Lag errors ("beyond current head", pruned history on one backend) are retried with
 * backoff; a "range too large" answer splits the range in two.
 */
async function fetchRange(client: PublicClient, address: Address, range: BlockRange): Promise<RawLog[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await client.getLogs({ address, fromBlock: range.fromBlock, toBlock: range.toBlock })) as RawLog[];
    } catch (error) {
      const span = range.toBlock - range.fromBlock + 1n;
      const message = error instanceof Error ? error.message : String(error);
      if (!isLagError(error) && RANGE_TOO_LARGE_RE.test(message) && span > 1n) {
        const mid = range.fromBlock + span / 2n;
        const first = await fetchRange(client, address, { fromBlock: range.fromBlock, toBlock: mid - 1n });
        const second = await fetchRange(client, address, { fromBlock: mid, toBlock: range.toBlock });
        return [...first, ...second];
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isLagError(error)) throw error;
      await sleep(delay);
    }
  }
}

export interface ScanOptions {
  readonly fromBlock: bigint;
  /** Must be a block this tab already saw (a receipt or a head we read): never "latest" (RPC lag). */
  readonly toBlock: bigint;
  readonly newestFirst?: boolean;
}

/** Decoded BluffDice events, chunk by chunk. Inside a chunk, logs keep chain order. */
export async function* scanGameLogs(client: PublicClient, { fromBlock, toBlock, newestFirst = false }: ScanOptions) {
  for (const range of chunkRanges(fromBlock, toBlock, { newestFirst })) {
    const raw = await fetchRange(client, BLUFF_DICE_ADDRESS, range);
    yield { range, logs: decodeGameLogs(raw) };
  }
}

/** Decoded BluffChips events (OperatorSet, ConfidentialTransfer, ...), chunk by chunk. */
export async function* scanChipLogs(client: PublicClient, { fromBlock, toBlock, newestFirst = false }: ScanOptions) {
  for (const range of chunkRanges(fromBlock, toBlock, { newestFirst })) {
    const raw = await fetchRange(client, BLUFF_CHIPS_ADDRESS, range);
    yield { range, logs: decodeChipLogs(raw) };
  }
}

export function decodeGameLogs(logs: readonly RawLog[]) {
  return parseEventLogs({ abi: bluffDiceAbi, logs: [...logs], strict: true });
}

export function decodeChipLogs(logs: readonly RawLog[]) {
  return parseEventLogs({ abi: bluffChipsAbi, logs: [...logs], strict: true });
}

export type GameLog = ReturnType<typeof decodeGameLogs>[number];
export type ChipLog = ReturnType<typeof decodeChipLogs>[number];

/**
 * Newest-first discovery: the newest decoded game log matching `predicate`, scanning back from `toBlock` and
 * stopping at the first chunk with a match (e.g. the bot's newest TableCreated).
 */
export async function findNewestGameLog(
  client: PublicClient,
  options: Omit<ScanOptions, "newestFirst">,
  predicate: (log: GameLog) => boolean,
): Promise<GameLog | undefined> {
  for await (const { logs } of scanGameLogs(client, { ...options, newestFirst: true })) {
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      if (log && predicate(log)) return log;
    }
  }
  return undefined;
}

/**
 * The newest `OperatorSet(holder, operator, until)` for `holder` -> BluffDice. OZ 0.5.3 keeps `until` private
 * (only `isOperator` is public), so the expiry is read from the event. Only recent blocks are scanned: the app
 * sets a 10-minute expiry; an older grant that `isOperator` still reports as valid is long-lived.
 */
export async function findOperatorExpiry(
  client: PublicClient,
  holder: Address,
  options: Omit<ScanOptions, "newestFirst">,
): Promise<bigint | undefined> {
  for await (const { logs } of scanChipLogs(client, { ...options, newestFirst: true })) {
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      if (
        log?.eventName === "OperatorSet" &&
        log.args.holder.toLowerCase() === holder.toLowerCase() &&
        log.args.operator.toLowerCase() === BLUFF_DICE_ADDRESS.toLowerCase()
      ) {
        return BigInt(log.args.until);
      }
    }
  }
  return undefined;
}
