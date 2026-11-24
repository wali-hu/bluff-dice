/** Test fixtures: tables, raw logs and a fake read client (no network). Used by unit tests only. */
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type PublicClient } from "viem";

import { Phase, type TableView } from "@/chain/reads";
import { bluffChipsAbi, bluffDiceAbi } from "@/contracts/abi";
import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS } from "@/contracts/addresses";

import type { TableEntry } from "./lobby";
import { DEFAULT_STAKE } from "./stakes";

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const ALICE = "0x1111111111111111111111111111111111111111" as Address;
export const BOB = "0x2222222222222222222222222222222222222222" as Address;
export const BOT = "0xb0b0000000000000000000000000000000000b07" as Address;

export function table(over: Omit<Partial<TableView>, "players"> & { players?: Address[] } = {}): TableView {
  const players = (over.players ?? [ALICE])
    .concat([ZERO, ZERO, ZERO, ZERO])
    .slice(0, 4) as unknown as TableView["players"];
  return {
    phase: Phase.Joining,
    maxPlayers: 2,
    playerCount: players.filter((p) => p !== ZERO).length,
    turnSeat: 255,
    bidQuantity: 0,
    bidFace: 0,
    bidderSeat: 255,
    liarCallerSeat: 255,
    loserSeat: 255,
    revealedCount: 0,
    round: 0,
    deadline: 0n,
    stake: DEFAULT_STAKE,
    ...over,
    players,
  } as TableView;
}

export function entry(
  id: number,
  over: Omit<Partial<TableView>, "players"> & { players?: Address[] } = {},
): TableEntry {
  return { id: BigInt(id), table: table(over) };
}

let logIndex = 0;
function rawLog(address: Address, topics: Hex[], data: Hex, blockNumber: bigint) {
  const [first, ...rest] = topics;
  logIndex++;
  return {
    address,
    topics: [first as Hex, ...rest] as [Hex, ...Hex[]],
    data,
    blockNumber,
    blockHash: `0x${"aa".repeat(32)}` as Hex,
    logIndex,
    transactionHash: `0x${logIndex.toString(16).padStart(64, "0")}` as Hex,
    transactionIndex: 0,
    removed: false,
  };
}

export function tableCreatedLog(
  tableId: bigint,
  creator: Address,
  blockNumber: bigint,
  stake = DEFAULT_STAKE,
  maxPlayers = 2,
) {
  const topics = encodeEventTopics({
    abi: bluffDiceAbi,
    eventName: "TableCreated",
    args: { tableId, creator },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: "uint64" }, { type: "uint8" }], [stake, maxPlayers]);
  return rawLog(BLUFF_DICE_ADDRESS, topics, data, blockNumber);
}

export function operatorSetLog(holder: Address, operator: Address, until: number, blockNumber: bigint) {
  const topics = encodeEventTopics({
    abi: bluffChipsAbi,
    eventName: "OperatorSet",
    args: { holder, operator },
  }) as Hex[];
  const data = encodeAbiParameters([{ type: "uint48" }], [until]);
  return rawLog(BLUFF_CHIPS_ADDRESS, topics, data, blockNumber);
}

/** A fake read client: tables by id, dropped (id:player) pairs, logs by block, a head block. */
export function fakeClient(opts: {
  tables: Map<bigint, TableView>;
  dropped?: Set<string>;
  logs?: ReturnType<typeof tableCreatedLog>[];
  head?: bigint;
  nextTableId?: bigint;
}) {
  const calls = { getLogs: [] as { fromBlock: bigint; toBlock: bigint }[], multicall: 0 };
  const client = {
    getBlockNumber: async () => opts.head ?? 1_000_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.getLogs.push({ fromBlock, toBlock });
      return (opts.logs ?? []).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "nextTableId") return opts.nextTableId ?? BigInt(opts.tables.size + 1);
      throw new Error(`unexpected read ${functionName}`);
    },
    multicall: async ({ contracts }: { contracts: { functionName: string; args: unknown[] }[] }) => {
      calls.multicall++;
      return contracts.map(({ functionName, args }) => {
        const id = args[0] as bigint;
        if (functionName === "getTable") {
          const t = opts.tables.get(id);
          return t ? { status: "success", result: t } : { status: "failure", error: new Error("TableNotFound") };
        }
        if (functionName === "dropped") {
          return { status: "success", result: opts.dropped?.has(`${id}:${String(args[1]).toLowerCase()}`) ?? false };
        }
        throw new Error(`unexpected multicall ${functionName}`);
      });
    },
  } as unknown as PublicClient;
  return { client, calls };
}

type DiceEvent = Extract<(typeof bluffDiceAbi)[number], { type: "event" }>;

/** Any BluffDice event as a raw log (indexed args -> topics, the rest -> data), for timeline tests. */
export function gameEventLog(
  eventName: DiceEvent["name"],
  args: Record<string, unknown>,
  blockNumber: bigint,
  txHash?: Hex,
) {
  const item = bluffDiceAbi.find((x) => x.type === "event" && x.name === eventName) as DiceEvent;
  const indexed = Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]]));
  const plain = item.inputs.filter((i) => !i.indexed);
  const topics = encodeEventTopics({ abi: [item], eventName, args: indexed } as never) as Hex[];
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name]) as never);
  const log = rawLog(BLUFF_DICE_ADDRESS, topics, data, blockNumber);
  return txHash ? { ...log, transactionHash: txHash } : log;
}
