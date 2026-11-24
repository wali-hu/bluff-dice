import { describe, expect, it } from "vitest";

import { Phase } from "@/chain/reads";

import { ALICE, BOB, BOT, entry, table } from "./fixtures";
import { groupTables, pickBotTable, pickQuickPlay } from "./lobby";
import { CHIP } from "./stakes";

describe("groupTables", () => {
  const entries = [
    entry(1, { phase: Phase.Settled, players: [ALICE, BOB], playerCount: 2 }),
    entry(2, { players: [BOB] }),
    entry(3, { players: [ALICE] }),
    entry(4, { phase: Phase.Bidding, players: [BOB, ALICE] }),
    entry(5, { phase: Phase.Cancelled, players: [] }),
    entry(6, { phase: Phase.AwaitingPaidProof, players: [BOB, ZERO_SAFE()] }),
  ];

  it("splits mine / open / finished, newest first", () => {
    const g = groupTables(entries, ALICE);
    expect(g.mine.map((e) => e.id)).toEqual([4n, 3n]);
    expect(g.open.map((e) => e.id)).toEqual([2n]);
    expect(g.finished.map((e) => e.id)).toEqual([5n, 1n]);
  });

  it("without a wallet everything open is open", () => {
    expect(groupTables(entries, undefined).open.map((e) => e.id)).toEqual([3n, 2n]);
  });
});

function ZERO_SAFE() {
  return BOB;
}

describe("pickQuickPlay", () => {
  const tables = new Map([
    [10n, table({ players: [BOB] })],
    [11n, table({ players: [BOB] })],
    [12n, table({ players: [BOT] })],
    [13n, table({ players: [BOB], stake: 30n * CHIP })],
    [14n, table({ players: [BOB], maxPlayers: 3 })],
    [15n, table({ players: [ALICE] })],
    [16n, table({ players: [BOB, ALICE], playerCount: 2 })],
  ]);
  const c = (id: number, block: number, creator = BOB) => ({ id: BigInt(id), createdBlock: BigInt(block), creator });

  it("takes the NEWEST recent open 2p/60 non-bot table", () => {
    const pick = pickQuickPlay([c(10, 100), c(11, 120)], tables, { viewer: ALICE, bot: BOT, minBlock: 50n });
    expect(pick).toBe(11n);
  });

  it("skips old, bot, other stake, other size, own and full tables", () => {
    const candidates = [c(10, 10), c(12, 130, BOT), c(13, 131), c(14, 132), c(15, 133, ALICE), c(16, 134)];
    expect(pickQuickPlay(candidates, tables, { viewer: ALICE, bot: BOT, minBlock: 50n })).toBeUndefined();
  });

  it("skips tables the viewer was dropped from", () => {
    const pick = pickQuickPlay([c(10, 100), c(11, 120)], tables, {
      viewer: ALICE,
      bot: BOT,
      minBlock: 50n,
      droppedIds: new Set([11n]),
    });
    expect(pick).toBe(10n);
  });
});

describe("pickBotTable", () => {
  it("bot at seat 0, Joining with a free seat, not dropped, newest first", () => {
    const entries = [
      entry(1, { players: [BOT] }),
      entry(2, { players: [BOT] }),
      entry(3, { players: [BOB] }),
      entry(4, { players: [BOT, BOB], playerCount: 2 }),
    ];
    expect(pickBotTable(entries, BOT)).toBe(2n);
    expect(pickBotTable(entries, BOT, new Set([2n]))).toBe(1n);
    expect(pickBotTable(entries, null)).toBeUndefined();
  });

  it("ignores a table the bot joined but did not create", () => {
    expect(pickBotTable([entry(5, { players: [BOB, BOT], playerCount: 2, maxPlayers: 3 })], BOT)).toBeUndefined();
  });
});
