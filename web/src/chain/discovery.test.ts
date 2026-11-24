import { describe, expect, it } from "vitest";

import { BLUFF_DICE_ADDRESS } from "@/contracts/addresses";
import { ALICE, BOB, BOT, fakeClient, operatorSetLog, table, tableCreatedLog } from "@/lib/fixtures";
import { CHIP } from "@/lib/stakes";

import { findBotTable, findQuickPlayTable, getLobbyTables, tableIdFromReceipt } from "./discovery";
import { decodeChipLogs, operatorUntilFromLogs } from "./logs";

describe("findBotTable", () => {
  it("uses the lobby multicall first (no logs read)", async () => {
    const tables = new Map([
      [1n, table({ players: [BOB] })],
      [2n, table({ players: [BOT] })],
    ]);
    const { client, calls } = fakeClient({ tables });
    expect(await findBotTable(client, ALICE, { bot: BOT })).toBe(2n);
    expect(calls.getLogs).toHaveLength(0);
  });

  it("skips a bot table the viewer was dropped from", async () => {
    const tables = new Map([
      [1n, table({ players: [BOT] })],
      [2n, table({ players: [BOT] })],
    ]);
    const { client } = fakeClient({ tables, dropped: new Set([`2:${ALICE.toLowerCase()}`]) });
    expect(await findBotTable(client, ALICE, { bot: BOT })).toBe(1n);
  });

  it("falls back to TableCreated logs (creator == bot), newest first, beyond the lobby's 50 ids", async () => {
    const tables = new Map<bigint, ReturnType<typeof table>>();
    for (let id = 1n; id <= 60n; id++) tables.set(id, table({ players: [BOB, ALICE], playerCount: 2 }));
    tables.set(3n, table({ players: [BOT] }));
    const logs = [tableCreatedLog(3n, BOT, 900_000n), tableCreatedLog(4n, BOB, 900_001n)];
    const { client, calls } = fakeClient({ tables, logs, head: 1_000_000n, nextTableId: 61n });
    expect(await findBotTable(client, ALICE, { bot: BOT, fromBlock: 800_000n })).toBe(3n);
    expect(calls.getLogs[0]).toEqual({ fromBlock: 950_001n, toBlock: 1_000_000n });
    for (const range of calls.getLogs) expect(range.toBlock - range.fromBlock + 1n).toBeLessThanOrEqual(50_000n);
  });

  it("returns undefined when bot mode is off", async () => {
    const { client } = fakeClient({ tables: new Map([[1n, table({ players: [BOT] })]]) });
    expect(await findBotTable(client, ALICE, { bot: null })).toBeUndefined();
  });
});

describe("findQuickPlayTable", () => {
  it("reads only the last ~75 blocks and picks the newest matching table", async () => {
    const tables = new Map([
      [7n, table({ players: [BOB] })],
      [8n, table({ players: [BOB], stake: 30n * CHIP })],
      [9n, table({ players: [BOB] })],
    ]);
    const logs = [
      tableCreatedLog(7n, BOB, 999_950n),
      tableCreatedLog(8n, BOB, 999_960n, 30n * CHIP),
      tableCreatedLog(9n, BOB, 999_900n), // older than the window
    ];
    const { client, calls } = fakeClient({ tables, logs, head: 1_000_000n });
    expect(await findQuickPlayTable(client, ALICE, BOT)).toBe(7n);
    expect(calls.getLogs).toEqual([{ fromBlock: 999_925n, toBlock: 1_000_000n }]);
  });
});

describe("lobby + receipts + operator logs", () => {
  it("reads the newest 50 ids", async () => {
    const tables = new Map<bigint, ReturnType<typeof table>>();
    for (let id = 1n; id <= 70n; id++) tables.set(id, table());
    const { client } = fakeClient({ tables, nextTableId: 71n });
    const lobby = await getLobbyTables(client);
    expect(lobby).toHaveLength(50);
    expect(lobby.map((e) => e.id)).toContain(70n);
    expect(lobby.map((e) => e.id)).not.toContain(20n);
  });

  it("finds the new table id in a createTable receipt", () => {
    const log = tableCreatedLog(42n, ALICE, 5n);
    const foreign = { ...tableCreatedLog(7n, ALICE, 5n), address: BOB };
    expect(tableIdFromReceipt({ logs: [foreign, log] })).toBe(42n);
    expect(tableIdFromReceipt({ logs: [] })).toBeUndefined();
  });

  it("parses operator `until` from the newest OperatorSet(holder, BluffDice)", () => {
    const logs = decodeChipLogs([
      operatorSetLog(ALICE, BLUFF_DICE_ADDRESS, 1_000, 1n),
      operatorSetLog(ALICE, BOB, 9_999, 2n), // other operator
      operatorSetLog(BOB, BLUFF_DICE_ADDRESS, 8_888, 3n), // other holder
      operatorSetLog(ALICE, BLUFF_DICE_ADDRESS, 2_000, 4n),
    ] as never);
    expect(operatorUntilFromLogs(logs, ALICE)).toBe(2_000n);
    expect(operatorUntilFromLogs(logs, "0x3333333333333333333333333333333333333333")).toBeUndefined();
  });
});
