import type { Address, ContractFunctionArgs, ContractFunctionReturnType, Hex, PublicClient } from "viem";

import { bluffChipsAbi, bluffDiceAbi } from "@/contracts/abi";
import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS, MULTICALL3_ADDRESS } from "@/contracts/addresses";

import { getPinnedBlock } from "./readPin";

const dice = { address: BLUFF_DICE_ADDRESS, abi: bluffDiceAbi } as const;
const chips = { address: BLUFF_CHIPS_ADDRESS, abi: bluffChipsAbi } as const;

/** Table phases, same order as `enum Phase` in BluffDice.sol (checked by a unit test). */
export const Phase = {
  None: 0,
  Joining: 1,
  AwaitingPaidProof: 2,
  Bidding: 3,
  AwaitingReveal: 4,
  Settled: 5,
  Cancelled: 6,
} as const;
export type PhaseValue = (typeof Phase)[keyof typeof Phase];

/** `NO_SEAT` in the contract. */
export const NO_SEAT = 255;

/**
 * RPC lag rule (BUILD-LOG Phase D): a load-balanced node can answer from a block before our last receipt.
 * These errors mean "that node is behind or pruned"; retrying (often hitting another node) fixes them.
 */
const LAG_ERROR_RE =
  /header not found|unknown block|block not found|beyond current head|cannot query unfinalized|missing trie node|pruned history unavailable/i;

export function isLagError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ""}` : "";
  return LAG_ERROR_RE.test(text);
}

const LAG_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `read`, retrying lag errors with backoff (1, 2, 4 s). Other errors are thrown at once. */
export async function withLagRetry<T>(read: () => Promise<T>, delays: readonly number[] = LAG_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isLagError(error)) throw error;
      await sleep(delay);
    }
  }
}

/**
 * The block to read at: undefined (= "latest") when nothing is pinned, else max(head, pinned). Reading at an
 * explicit block makes a lagging node fail loudly (retried) instead of answering with old state.
 */
export async function readBlockNumber(client: PublicClient, minBlock = getPinnedBlock()): Promise<bigint | undefined> {
  if (minBlock === undefined) return undefined;
  const head = await client.getBlockNumber({ cacheTime: 0 });
  return head >= minBlock ? head : minBlock;
}

async function readDice<const F extends DiceReadName>(
  client: PublicClient,
  functionName: F,
  args: DiceReadArgs<F>,
): Promise<DiceReadResult<F>> {
  return withLagRetry(async () => {
    const blockNumber = await readBlockNumber(client);
    return client.readContract({ ...dice, functionName, args, blockNumber } as never) as Promise<DiceReadResult<F>>;
  });
}

async function readChips<const F extends ChipsReadName>(
  client: PublicClient,
  functionName: F,
  args: ChipsReadArgs<F>,
): Promise<ChipsReadResult<F>> {
  return withLagRetry(async () => {
    const blockNumber = await readBlockNumber(client);
    return client.readContract({ ...chips, functionName, args, blockNumber } as never) as Promise<ChipsReadResult<F>>;
  });
}

// ---- typed views -------------------------------------------------------------------------------------------

export type TableView = Awaited<ReturnType<typeof getTable>>;

export function getTable(client: PublicClient, tableId: bigint) {
  return readDice(client, "getTable", [tableId]);
}

export function getNextTableId(client: PublicClient) {
  return readDice(client, "nextTableId", []);
}

/** Seat index of `player`, or `NO_SEAT` (255) when not seated. */
export function getSeatOf(client: PublicClient, tableId: bigint, player: Address) {
  return readDice(client, "seatOf", [tableId, player]);
}

/** Exact handle list `startGame` checks (seat order). */
export function getPaidHandles(client: PublicClient, tableId: bigint): Promise<readonly Hex[]> {
  return readDice(client, "paidHandles", [tableId]);
}

/** Exact handle list `finalizeReveal` checks (seat order, then die order). */
export function getRevealHandles(client: PublicClient, tableId: bigint): Promise<readonly Hex[]> {
  return readDice(client, "revealHandles", [tableId]);
}

/** The five encrypted dice handles of a seated player (decryptable by that player only until a reveal). */
export function getDiceOf(client: PublicClient, tableId: bigint, player: Address): Promise<readonly Hex[]> {
  return readDice(client, "diceOf", [tableId, player]);
}

export function getIsOperator(client: PublicClient, holder: Address, spender: Address = BLUFF_DICE_ADDRESS) {
  return readChips(client, "isOperator", [holder, spender]);
}

/** Unix seconds of the last faucet claim (0 = never). */
export function getLastFaucet(client: PublicClient, account: Address) {
  return readChips(client, "lastFaucet", [account]);
}

/** Encrypted chip balance handle (`bytes32(0)` = never funded). */
export function getBalanceHandle(client: PublicClient, account: Address): Promise<Hex> {
  return readChips(client, "confidentialBalanceOf", [account]);
}

/**
 * Lobby batch: many `getTable` calls in one Multicall3 request. Missing tables (TableNotFound) come back as
 * null instead of failing the whole batch.
 */
export async function getTables(client: PublicClient, tableIds: readonly bigint[]) {
  if (tableIds.length === 0) return new Map<bigint, TableView>();
  const results = await withLagRetry(async () => {
    const blockNumber = await readBlockNumber(client);
    return client.multicall({
      contracts: tableIds.map((id) => ({ ...dice, functionName: "getTable", args: [id] }) as const),
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
      blockNumber,
    });
  });
  const tables = new Map<bigint, TableView>();
  results.forEach((result, i) => {
    const id = tableIds[i];
    if (id !== undefined && result.status === "success") tables.set(id, result.result as TableView);
  });
  return tables;
}

// ---- helper types (view functions only) ----------------------------------------------------------------------

type ViewFn<Abi> = Extract<Abi extends readonly (infer I)[] ? I : never, { type: "function"; stateMutability: "view" }>;
type DiceRead = ViewFn<typeof bluffDiceAbi>;
type ChipsRead = ViewFn<typeof bluffChipsAbi>;
type DiceReadName = DiceRead["name"];
type ChipsReadName = ChipsRead["name"];

type DiceReadArgs<F extends DiceReadName> = ContractFunctionArgs<typeof bluffDiceAbi, "view", F>;
type DiceReadResult<F extends DiceReadName> = ContractFunctionReturnType<typeof bluffDiceAbi, "view", F>;
type ChipsReadArgs<F extends ChipsReadName> = ContractFunctionArgs<typeof bluffChipsAbi, "view", F>;
type ChipsReadResult<F extends ChipsReadName> = ContractFunctionReturnType<typeof bluffChipsAbi, "view", F>;

/** Table ids (from `ids`) that dropped `player` as a non-payer: they cannot rejoin those tables. */
export async function getDroppedIds(
  client: PublicClient,
  tableIds: readonly bigint[],
  player: Address,
): Promise<Set<bigint>> {
  if (tableIds.length === 0) return new Set();
  const results = await withLagRetry(async () => {
    const blockNumber = await readBlockNumber(client);
    return client.multicall({
      contracts: tableIds.map((id) => ({ ...dice, functionName: "dropped", args: [id, player] }) as const),
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
      blockNumber,
    });
  });
  const dropped = new Set<bigint>();
  results.forEach((result, i) => {
    const id = tableIds[i];
    if (id !== undefined && result.status === "success" && result.result === true) dropped.add(id);
  });
  return dropped;
}

/** The newest `count` table ids (nextTableId - 1 down to 1). */
export function newestTableIds(nextTableId: bigint, count = 50): bigint[] {
  const ids: bigint[] = [];
  for (let id = nextTableId - 1n; id >= 1n && ids.length < count; id--) ids.push(id);
  return ids;
}
