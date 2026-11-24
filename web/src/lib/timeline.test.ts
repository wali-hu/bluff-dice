import { describe, expect, it } from "vitest";

import { fetchTableTimeline, TABLE_LOG_SPAN } from "@/chain/tableLogs";
import { decodeGameLogs } from "@/chain/logs";
import { Phase } from "@/chain/reads";

import { ALICE, BOB, fakeClient, gameEventLog } from "./fixtures";
import { buildTimeline, historyView } from "./timeline";

const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

function story(tableId = 11n) {
  return [
    gameEventLog("TableCreated", { tableId, creator: ALICE, stake: 60_000_000n, maxPlayers: 2 }, 100n, TX(1)),
    gameEventLog("PaidCheckRequested", { tableId, deadline: 5_000n }, 101n, TX(2)),
    gameEventLog("GameStarted", { tableId, round: 1, firstSeat: 0, deadline: 6_000n }, 102n, TX(3)),
    gameEventLog(
      "BidPlaced",
      { tableId, round: 1, bidder: ALICE, quantity: 2, face: 3, nextSeat: 1, deadline: 7n },
      103n,
      TX(4),
    ),
    gameEventLog(
      "BidPlaced",
      { tableId, round: 1, bidder: BOB, quantity: 3, face: 5, nextSeat: 0, deadline: 8n },
      104n,
      TX(5),
    ),
    gameEventLog(
      "BidPlaced",
      { tableId: 99n, round: 1, bidder: BOB, quantity: 9, face: 9, nextSeat: 0, deadline: 8n },
      104n,
      TX(9),
    ),
    gameEventLog(
      "LiarCalled",
      { tableId, round: 1, caller: ALICE, bidder: BOB, quantity: 3, face: 5, revealDeadline: 9n },
      105n,
      TX(6),
    ),
    gameEventLog("RoundRevealed", { tableId, round: 1, loser: BOB, count: 2, quantity: 3, face: 5 }, 106n, TX(7)),
    gameEventLog("WinningsPaid", { tableId, round: 1, winner: ALICE, amount: 120_000_000n }, 106n, TX(7)),
  ];
}

describe("buildTimeline (history decoding)", () => {
  it("bids newest first, phase txs, deal block, winnings; other tables ignored", () => {
    const tl = buildTimeline(decodeGameLogs(story() as never), 11n, 1);
    expect(tl.complete).toBe(true);
    expect(tl.gameStartedBlock).toBe(102n);
    expect(tl.bids.map((b) => `${b.quantity}x${b.face}`)).toEqual(["3x5", "2x3"]);
    expect(tl.phaseTx[Phase.Bidding]).toBe(TX(3));
    expect(tl.phaseTx[Phase.AwaitingReveal]).toBe(TX(6));
    expect(tl.phaseTx[Phase.Settled]).toBe(TX(7));
    expect(tl.winnings).toEqual([{ winner: ALICE, amount: 120_000_000n }]);
  });
});

describe("historyView", () => {
  const table = { bidQuantity: 3, bidFace: 5, bidderSeat: 1 };
  it("full when the logs reach the deal", () => {
    const tl = buildTimeline(decodeGameLogs(story().slice(2) as never), 11n, 1);
    expect(historyView(tl, table).kind).toBe("full");
  });

  it("degraded (no logs / pruned history): the current bid from the contract", () => {
    expect(historyView(null, table)).toEqual({ kind: "degraded", current: { quantity: 3, face: 5, bidderSeat: 1 } });
    expect(historyView(null, { bidQuantity: 0, bidFace: 0, bidderSeat: 255 })).toEqual({
      kind: "degraded",
      current: null,
    });
    const partial = buildTimeline(decodeGameLogs(story().slice(3, 5) as never), 11n, 1);
    expect(historyView(partial, table).kind).toBe("degraded");
  });
});

describe("fetchTableTimeline (bounded getLogs)", () => {
  it("small recent ranges, newest first, stops at TableCreated", async () => {
    const logs = story().map((l) => ({ ...l, blockNumber: l.blockNumber + 996_000n }));
    const { client, calls } = fakeClient({ tables: new Map(), logs: logs as never, head: 1_000_000n });
    const tl = await fetchTableTimeline(client, 11n, 1);
    expect(tl.complete).toBe(true);
    for (const r of calls.getLogs) expect(r.toBlock - r.fromBlock + 1n).toBeLessThanOrEqual(TABLE_LOG_SPAN);
    expect(calls.getLogs[0]).toEqual({ fromBlock: 999_001n, toBlock: 1_000_000n });
    expect(calls.getLogs.length).toBe(4); // TableCreated at 996,100 is in the 4th range back
  });

  it("a table older than the ~1-day window is incomplete (history degrades to contract state)", async () => {
    const logs = story().map((l) => ({ ...l, blockNumber: l.blockNumber + 900_000n }));
    const { client, calls } = fakeClient({ tables: new Map(), logs: logs as never, head: 1_000_000n });
    const tl = await fetchTableTimeline(client, 11n, 1);
    expect(tl.complete).toBe(false);
    expect(calls.getLogs.at(-1)?.fromBlock).toBe(992_800n);
  });

  it("a refresh starts at the known TableCreated block", async () => {
    const { client, calls } = fakeClient({ tables: new Map(), logs: [], head: 1_000_000n });
    await fetchTableTimeline(client, 11n, 1, 999_500n);
    expect(calls.getLogs).toEqual([{ fromBlock: 999_500n, toBlock: 1_000_000n }]);
  });
});
