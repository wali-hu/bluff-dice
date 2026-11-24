/**
 * E5 spec tests (docs/SPEC.md "E5 table view rules", approved 2026-11-24). One test per must-succeed / must-fail
 * case, named after its rule. These tests ARE the spec: never edit them to match the code; a wrong test is a spec
 * change and needs the owner's approval.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { UserRejectedRequestError, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { decodeGameLogs } from "@/chain/logs";
import { NO_SEAT, Phase } from "@/chain/reads";
import { BLUFF_DICE_ADDRESS } from "@/contracts/addresses";
import * as bidRules from "@/lib/bidRules";
import * as errors from "@/lib/errors";
import { ALICE, BOB, entry, gameEventLog, ZERO } from "@/lib/fixtures";
import { groupTables } from "@/lib/lobby";
import { elsewhereNotice, seatSituation } from "@/lib/playNow";
import * as tableRoom from "@/lib/tableRoom";
import * as tableView from "@/lib/tableView";
import * as timeline from "@/lib/timeline";

// Loose handles on purpose: the spec names the API; a missing export fails only its own tests.
/* eslint-disable @typescript-eslint/no-explicit-any */
const tv = tableView as any;
const br = bidRules as any;
const er = errors as any;
const tr = tableRoom as any;
const tl = timeline as any;

const CAROL = "0x3333333333333333333333333333333333333333" as Address;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ZERO_HANDLE = `0x${"0".repeat(64)}` as Hex;

const shared = JSON.parse(readFileSync(fileURLToPath(new URL("./e5-bid-cases.json", import.meta.url)), "utf8")) as {
  playerCount: number;
  cases: { name: string; players?: number; prev: [number, number]; bid: [number, number]; expect: string }[];
};

// ---- E5-R1 ---------------------------------------------------------------------------------------------------
describe("E5-R1: seats", () => {
  const players = [ALICE, BOB, ZERO, ZERO];
  it("E5-R1: seats in order with you and turn marker", () => {
    const rows = tv.seatRows({ players, maxPlayers: 2, phase: Phase.Bidding, turnSeat: 1, viewer: BOB });
    expect(rows.map((r: any) => r.seat)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({ address: ALICE, you: false, turn: false });
    expect(rows[1]).toMatchObject({ address: BOB, you: true, turn: true });
  });
  it("E5-R1: empty seat is not a player", () => {
    const rows = tv.seatRows({ players, maxPlayers: 3, phase: Phase.Joining, turnSeat: NO_SEAT, viewer: ALICE });
    expect(rows).toHaveLength(3);
    expect(rows[2].address).toBeNull();
    expect(rows[2].you).toBe(false);
  });
  it("E5-R1: no turn marker outside Bidding", () => {
    for (const phase of [Phase.Joining, Phase.AwaitingPaidProof, Phase.AwaitingReveal, Phase.Settled]) {
      const rows = tv.seatRows({ players, maxPlayers: 2, phase, turnSeat: 0, viewer: ALICE });
      expect(rows.some((r: any) => r.turn)).toBe(false);
    }
  });
  it("E5-R1: spectator has no you", () => {
    for (const viewer of [CAROL, undefined]) {
      const rows = tv.seatRows({ players, maxPlayers: 2, phase: Phase.Bidding, turnSeat: 0, viewer });
      expect(rows.some((r: any) => r.you)).toBe(false);
    }
  });
});

// ---- E5-R2 ---------------------------------------------------------------------------------------------------
describe("E5-R2: own dice", () => {
  const handles = [H(1), H(2), H(3), H(4), H(5)];
  it("E5-R2: decrypted own dice shown face-up", () => {
    const values = new Map<string, bigint>(handles.map((h, i) => [h, BigInt(i + 1)]));
    expect(tv.ownDiceView({ seated: true, handles, values })).toEqual({ kind: "faces", faces: [1, 2, 3, 4, 5] });
  });
  it("E5-R2: loading state before decrypt", () => {
    expect(tv.ownDiceView({ seated: true, handles, values: undefined }).kind).toBe("loading");
  });
  it("E5-R2: zero handles are skipped", () => {
    const items = tv.ownDiceDecryptItems({ viewerSeat: 0, handles: [ZERO_HANDLE, H(2)], contract: BLUFF_DICE_ADDRESS });
    expect(items).toEqual([{ handle: H(2), contract: BLUFF_DICE_ADDRESS }]);
  });
  it("E5-R2: out-of-range value is an error", () => {
    for (const bad of [0n, 7n]) {
      const values = new Map<string, bigint>(handles.map((h, i) => [h, i === 2 ? bad : 1n]));
      const view = tv.ownDiceView({ seated: true, handles, values });
      expect(view.kind).toBe("error");
      expect(JSON.stringify(view)).not.toMatch(/0x[0-9a-f]{64}/i); // never a raw handle
    }
  });
  it("E5-R2: spectator has no own dice", () => {
    expect(tv.ownDiceView({ seated: false, handles: undefined, values: undefined }).kind).toBe("none");
    expect(tv.ownDiceDecryptItems({ viewerSeat: NO_SEAT, handles, contract: BLUFF_DICE_ADDRESS })).toEqual([]);
  });
});

// ---- E5-R3 ---------------------------------------------------------------------------------------------------
describe("E5-R3: other players' dice", () => {
  it("E5-R3: other seats show five cipher tiles", () => {
    for (const phase of [Phase.Bidding, Phase.AwaitingReveal]) {
      const rows = tv.seatRows({ players: [ALICE, BOB, ZERO, ZERO], maxPlayers: 2, phase, turnSeat: 0, viewer: ALICE });
      expect(rows[0].dice).toBe("own");
      expect(rows[1].dice).toBe("cipher");
    }
  });
  it("E5-R3: only own handles are requested for decrypt", () => {
    const own = [H(11), H(12), H(13), H(14), H(15)];
    const items = tv.ownDiceDecryptItems({ viewerSeat: 1, handles: own, contract: BLUFF_DICE_ADDRESS });
    expect(items.map((i: any) => i.handle)).toEqual(own);
    expect(items.every((i: any) => i.contract === BLUFF_DICE_ADDRESS)).toBe(true);
  });
});

// ---- E5-R4 ---------------------------------------------------------------------------------------------------
describe("E5-R4: bid rule = contract rule", () => {
  const check = (prev: [number, number], bid: [number, number], players = 2) =>
    br.checkBid({ playerCount: players, prevQuantity: prev[0], prevFace: prev[1] }, bid[0], bid[1]);
  it("E5-R4: legal raises accepted", () => {
    expect(check([0, 0], [1, 1])).toBe("ok");
    expect(check([3, 4], [3, 5])).toBe("ok");
    expect(check([3, 6], [4, 1])).toBe("ok");
    expect(check([3, 4], [10, 1])).toBe("ok");
  });
  it("E5-R4: non-raises rejected", () => {
    for (const bid of [
      [3, 4],
      [3, 3],
      [2, 6],
    ] as [number, number][])
      expect(check([3, 4], bid)).toBe("BidNotHigher");
  });
  it("E5-R4: face out of range rejected", () => {
    expect(check([0, 0], [1, 0])).toBe("InvalidFace");
    expect(check([0, 0], [1, 7])).toBe("InvalidFace");
  });
  it("E5-R4: quantity out of range rejected", () => {
    expect(check([0, 0], [0, 1])).toBe("InvalidQuantity");
    expect(check([0, 0], [11, 1])).toBe("InvalidQuantity");
    expect(check([0, 0], [16, 1], 3)).toBe("InvalidQuantity");
  });
  it("E5-R4: app and contract agree on the shared case table", () => {
    for (const c of shared.cases) expect(check(c.prev, c.bid, c.players ?? shared.playerCount), c.name).toBe(c.expect);
  });
});

// ---- E5-R5 ---------------------------------------------------------------------------------------------------
describe("E5-R5: bid picker", () => {
  it("E5-R5: picker starts at smallest legal bid", () => {
    expect(br.smallestLegalBid({ playerCount: 2, prevQuantity: 0, prevFace: 0 })).toEqual({ quantity: 1, face: 1 });
    expect(br.smallestLegalBid({ playerCount: 2, prevQuantity: 3, prevFace: 4 })).toEqual({ quantity: 3, face: 5 });
    expect(br.smallestLegalBid({ playerCount: 2, prevQuantity: 3, prevFace: 6 })).toEqual({ quantity: 4, face: 1 });
    expect(br.BID_RULE_TEXT).toMatch(/higher quantity, or the same quantity (and|with) a higher face/i);
  });
  it("E5-R5: illegal pairs disabled", () => {
    const ctx = { playerCount: 2, prevQuantity: 3, prevFace: 4 };
    expect(br.legalFaces(ctx, 3)).toEqual([5, 6]);
    expect(br.legalFaces(ctx, 2)).toEqual([]);
    expect(br.legalFaces(ctx, 4)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("E5-R5: no legal bid leaves only LIAR", () => {
    expect(br.smallestLegalBid({ playerCount: 2, prevQuantity: 10, prevFace: 6 })).toBeNull();
    const a = tv.tableActions({
      phase: Phase.Bidding,
      mySeat: 1,
      turnSeat: 1,
      playerCount: 2,
      bidQuantity: 10,
      bidFace: 6,
      deadline: 1000n,
      nowSeconds: 900n,
      canWrite: true,
      pendingTx: false,
    });
    expect(a.bid).toBe(false);
    expect(a.liar).toBe(true);
  });
});

// ---- E5-R6 ---------------------------------------------------------------------------------------------------
describe("E5-R6: who may bid / call LIAR!", () => {
  const base = {
    phase: Phase.Bidding,
    mySeat: 0,
    turnSeat: 0,
    playerCount: 2,
    bidQuantity: 2,
    bidFace: 3,
    deadline: 1000n,
    nowSeconds: 900n,
    canWrite: true,
    pendingTx: false,
  };
  it("E5-R6: on turn in time can bid", () => {
    const a = tv.tableActions(base);
    expect(a.bid).toBe(true);
    expect(a.liar).toBe(true);
  });
  it("E5-R6: liar needs a bid", () => {
    const a = tv.tableActions({ ...base, bidQuantity: 0, bidFace: 0 });
    expect(a.bid).toBe(true);
    expect(a.liar).toBe(false);
    expect(a.liarReason).toBe("No bid to challenge yet");
  });
  it("E5-R6: not on turn cannot act", () => {
    const a = tv.tableActions({ ...base, mySeat: 1 });
    expect([a.bid, a.liar]).toEqual([false, false]);
    expect(a.reason).toEqual(expect.any(String));
  });
  it("E5-R6: spectator cannot act", () => {
    for (const over of [{ mySeat: NO_SEAT }, { canWrite: false }]) {
      const a = tv.tableActions({ ...base, ...over });
      expect([a.bid, a.liar]).toEqual([false, false]);
      expect(a.reason).toEqual(expect.any(String));
    }
  });
  it("E5-R6: deadline passed cannot act", () => {
    const a = tv.tableActions({ ...base, nowSeconds: 1001n });
    expect([a.bid, a.liar]).toEqual([false, false]);
    expect(a.reason).toEqual(expect.any(String));
  });
  it("E5-R6: pending tx blocks actions", () => {
    const a = tv.tableActions({ ...base, pendingTx: true });
    expect([a.bid, a.liar]).toEqual([false, false]);
    expect(a.reason).toEqual(expect.any(String));
  });
});

// ---- E5-R7 ---------------------------------------------------------------------------------------------------
describe("E5-R7: claim timeout", () => {
  const base = {
    phase: Phase.Bidding,
    turnSeat: 0,
    playerCount: 2,
    bidQuantity: 0,
    bidFace: 0,
    deadline: 1000n,
    canWrite: true,
    pendingTx: false,
  };
  it("E5-R7: claim timeout shown after deadline to everyone", () => {
    for (const mySeat of [0, 1, NO_SEAT]) {
      expect(tv.tableActions({ ...base, mySeat, nowSeconds: 1001n }).claimTimeout).toBe(true);
    }
  });
  it("E5-R7: hidden before deadline", () => {
    expect(tv.tableActions({ ...base, mySeat: NO_SEAT, nowSeconds: 1000n }).claimTimeout).toBe(false);
  });
  it("E5-R7: hidden outside Bidding", () => {
    for (const phase of [Phase.Joining, Phase.AwaitingPaidProof, Phase.AwaitingReveal, Phase.Settled]) {
      expect(tv.tableActions({ ...base, phase, mySeat: NO_SEAT, nowSeconds: 5000n }).claimTimeout).toBe(false);
    }
  });
  it("E5-R7: DeadlineNotPassed is a soft message", () => {
    const e = er.describeContractError("DeadlineNotPassed", [1n, 1000n]);
    expect(e.message).toContain("Not yet: the chain has not reached the deadline");
  });
});

// ---- E5-R8 ---------------------------------------------------------------------------------------------------
describe("E5-R8: cancel after a proof deadline", () => {
  it("E5-R8: cancel shown after proof deadline", () => {
    for (const phase of [Phase.AwaitingPaidProof, Phase.AwaitingReveal]) {
      expect(tr.cancelState(phase, 100n, 101n)).toEqual({ kind: "available" });
    }
  });
  it("E5-R8: hidden before deadline", () => {
    expect(tr.cancelState(Phase.AwaitingPaidProof, 100n, 100n).kind).not.toBe("available");
  });
  it("E5-R8: hidden in other phases", () => {
    for (const phase of [Phase.Joining, Phase.Bidding, Phase.Settled, Phase.Cancelled]) {
      expect(tr.cancelState(phase, 100n, 5000n)).toEqual({ kind: "none" });
    }
  });
});

// ---- E5-R9 ---------------------------------------------------------------------------------------------------
describe("E5-R9: bid history", () => {
  const bid = (tableId: bigint, round: number, bidder: Address, q: number, f: number, block: bigint, tx?: Hex) =>
    gameEventLog("BidPlaced", { tableId, round, bidder, quantity: q, face: f, nextSeat: 1, deadline: 0n }, block, tx);
  it("E5-R9: newest first", () => {
    const logs = decodeGameLogs([bid(7n, 1, ALICE, 1, 2, 10n), bid(7n, 1, BOB, 2, 3, 11n)]);
    const t = tl.buildTimeline(logs, 7n, 1);
    expect(t.bids.map((b: any) => [b.quantity, b.face])).toEqual([
      [2, 3],
      [1, 2],
    ]);
  });
  it("E5-R9: other table excluded", () => {
    const logs = decodeGameLogs([bid(7n, 1, ALICE, 1, 2, 10n), bid(8n, 1, BOB, 2, 3, 11n)]);
    expect(tl.buildTimeline(logs, 7n, 1).bids).toHaveLength(1);
  });
  it("E5-R9: other round excluded", () => {
    const logs = decodeGameLogs([bid(7n, 1, ALICE, 1, 2, 10n), bid(7n, 2, BOB, 2, 3, 11n)]);
    const t = tl.buildTimeline(logs, 7n, 2);
    expect(t.bids.map((b: any) => b.bidder)).toEqual([BOB]);
  });
  it("E5-R9: duplicate log shown once", () => {
    const one = bid(7n, 1, ALICE, 1, 2, 10n);
    const logs = decodeGameLogs([one, { ...one }]);
    expect(tl.buildTimeline(logs, 7n, 1).bids).toHaveLength(1);
  });
});

// ---- E5-R10 --------------------------------------------------------------------------------------------------
describe("E5-R10: deadline ring", () => {
  it("E5-R10: remaining time counts down", () => {
    const a = tv.deadlineRing(Phase.Bidding, 1000n, 900n);
    const b = tv.deadlineRing(Phase.Bidding, 1000n, 950n);
    expect(a.secondsLeft).toBe(100);
    expect(b.secondsLeft).toBe(50);
    expect(b.fraction).toBeLessThan(a.fraction);
  });
  it("E5-R10: past deadline shows time's up", () => {
    for (const now of [1000n, 1001n, 5000n]) {
      const r = tv.deadlineRing(Phase.Bidding, 1000n, now);
      expect(r.label).toBe("Time's up");
      expect(r.label).not.toMatch(/-\d/);
      expect(r.secondsLeft).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---- E5-R11 --------------------------------------------------------------------------------------------------
describe("E5-R11: table errors in words", () => {
  it("E5-R11: known table errors mapped", () => {
    expect(er.describeContractError("TurnExpired", [1n, 1000n]).message).toContain(
      "Too late: anyone can now claim the timeout",
    );
    expect(er.describeContractError("BidNotHigher", [3, 4, 3, 4]).message).toContain("Bid must be higher");
    expect(er.describeContractError("NotYourTurn", [1n, ALICE, BOB]).message).toContain("Not your turn");
    expect(er.describeContractError("NoBidToChallenge", [1n]).message).toContain("No bid to challenge yet");
  });
  it("E5-R11: WrongPhase is silent", () => {
    expect(er.describeContractError("WrongPhase", [1n, 3, 4]).silent).toBe(true);
  });
  it("E5-R11: technical details only in debug mode", () => {
    const raw = "execution reverted: 0xdeadbeefcafebabe0011223344556677";
    expect(er.technicalDetail(raw, false)).toBeNull();
    expect(er.technicalDetail(raw, true)).toBe(raw);
    expect(er.technicalDetail(undefined, true)).toBeNull();
  });
  it("E5-R11: unknown error is generic", () => {
    const e = er.toTxError(new Error("execution reverted: 0xdeadbeefcafebabe0011223344556677"));
    expect(e.message).not.toMatch(/0x[0-9a-f]{8,}/i);
    expect(e.message.length).toBeGreaterThan(0);
  });
});

// ---- E5-R12 --------------------------------------------------------------------------------------------------
describe("E5-R12: authorize again", () => {
  it("E5-R12: expired operator offers authorize again", () => {
    const e = er.describeContractError("ERC7984UnauthorizedSpender", [ALICE, BLUFF_DICE_ADDRESS]);
    expect(er.needsReauthorize(e)).toBe(true);
    expect(er.REAUTHORIZE_LABEL).toMatch(/^Authorize again/);
    expect(er.reauthorizeNext(true, 0)).toBe("retry");
  });
  it("E5-R12: other errors do not", () => {
    expect(er.needsReauthorize(er.describeContractError("BidNotHigher", [3, 4, 3, 4]))).toBe(false);
    expect(er.needsReauthorize({ kind: "rejected", message: "x" })).toBe(false);
    expect(er.needsReauthorize(null)).toBe(false);
  });
  it("E5-R12: failed authorize does not retry", () => {
    expect(er.reauthorizeNext(false, 0)).toBe("stop");
    expect(er.reauthorizeNext(true, 1)).toBe("stop"); // retried once already
  });
});

// ---- E5-R13 --------------------------------------------------------------------------------------------------
describe("E5-R13: already-seated notice on load", () => {
  const activeSeats = (entries: ReturnType<typeof entry>[], viewer: Address | undefined) =>
    groupTables(entries, viewer).mine.map((e) => e.id);
  const notice = (ids: bigint[], requested: bigint | undefined) =>
    elsewhereNotice({ situation: seatSituation(ids, requested), fromRun: null, anotherSeatChosen: false });
  it("E5-R13: notice on load for active seat elsewhere", () => {
    for (const phase of [Phase.Joining, Phase.AwaitingPaidProof, Phase.Bidding, Phase.AwaitingReveal]) {
      const ids = activeSeats([entry(10, { phase, players: [ALICE, BOB] })], BOB);
      expect(notice(ids, 11n)).toBe(10n);
    }
  });
  it("E5-R13: no notice for this table", () => {
    const ids = activeSeats([entry(11, { phase: Phase.Joining, players: [BOB] })], BOB);
    expect(notice(ids, 11n)).toBeNull();
  });
  it("E5-R13: no notice for finished tables", () => {
    for (const phase of [Phase.Settled, Phase.Cancelled]) {
      const ids = activeSeats([entry(10, { phase, players: [ALICE, BOB] })], BOB);
      expect(notice(ids, 11n)).toBeNull();
    }
  });
  it("E5-R13: no notice when disconnected", () => {
    const ids = activeSeats([entry(10, { phase: Phase.Bidding, players: [ALICE, BOB] })], undefined);
    expect(notice(ids, 11n)).toBeNull();
  });
});

// ---- E5-R14 --------------------------------------------------------------------------------------------------
describe("E5-R14: cancelled copy", () => {
  it("E5-R14: cancelled text", () => {
    expect(JSON.stringify(tr.roomView(Phase.Cancelled))).toContain("Cancelled: every stake was refunded");
  });
  it("E5-R14: no placeholder on cancelled", () => {
    expect(JSON.stringify(tr.roomView(Phase.Cancelled))).not.toMatch(/next update/i);
  });
  it("E5-R14: settled is not cancelled", () => {
    expect(JSON.stringify(tr.roomView(Phase.Settled))).not.toContain("Cancelled: every stake was refunded");
  });
});

// ---- E5-R15 --------------------------------------------------------------------------------------------------
describe("E5-R15: dice stay in memory, per account", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
    });
  it("E5-R15: dice not written to storage", () => {
    // Every module that touches dice, keys or signatures: the FHE client, the table view and its components.
    const watched = files(SRC).filter((p) =>
      /[\\/](fhe[\\/]|components[\\/](OwnDice|GameTable|PushPanel|UnlockCard|ChipsCard)|lib[\\/](tableView|timeline))/.test(
        p,
      ),
    );
    expect(watched.length).toBeGreaterThan(3);
    for (const p of watched) {
      const code = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, p).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
    }
  });
  it("E5-R15: account switch clears dice", () => {
    const a = tv.ownDiceQueryKey(7n, ALICE);
    const b = tv.ownDiceQueryKey(7n, BOB);
    expect(a).not.toEqual(b);
    expect(tv.ownDiceView({ seated: false, handles: undefined, values: undefined }).kind).toBe("none");
  });
});

// ---- E5-R16 --------------------------------------------------------------------------------------------------
describe("E5-R16: manual deal / reveal push", () => {
  const handles = [H(21), H(22)];
  const clear = "0x" + "00".repeat(31) + "01" + "00".repeat(31) + "01";
  const proof = "0x07abcdef" as Hex;
  const deps = (over: Partial<Record<string, any>> = {}) => ({
    readPhase: vi.fn(async () => Phase.AwaitingPaidProof),
    readHandles: vi.fn(async () => handles),
    publicDecrypt: vi.fn(async () => ({ abiEncoded: clear as Hex, proof })),
    send: vi.fn(async () => ({ ok: true as const })),
    ...over,
  });
  const push = async () => (await import("@/lib/push")) as any;

  it("E5-R16: deal decrypts exactly paidHandles and sends startGame unmodified", async () => {
    const { runPush } = await push();
    const d = deps();
    const out = await runPush({ kind: "deal", tableId: 9n, ...d });
    expect(out.result).toBe("pushed");
    expect(d.publicDecrypt).toHaveBeenCalledWith(handles);
    const write = (d.send.mock.calls[0] as any[])[0];
    expect(write.functionName).toBe("startGame");
    expect(write.args).toEqual([9n, clear, proof]);
  });
  it("E5-R16: reveal decrypts exactly revealHandles and sends finalizeReveal unmodified", async () => {
    const { runPush } = await push();
    const d = deps({ readPhase: vi.fn(async () => Phase.AwaitingReveal) });
    const out = await runPush({ kind: "reveal", tableId: 9n, ...d });
    expect(out.result).toBe("pushed");
    expect(d.publicDecrypt).toHaveBeenCalledWith(handles);
    const write = (d.send.mock.calls[0] as any[])[0];
    expect(write.functionName).toBe("finalizeReveal");
    expect(write.args).toEqual([9n, clear, proof]);
  });
  it("E5-R16: phase already moved is already-pushed", async () => {
    const { runPush } = await push();
    const d = deps({ readPhase: vi.fn(async () => Phase.Bidding) });
    const out = await runPush({ kind: "deal", tableId: 9n, ...d });
    expect(out.result).toBe("alreadyPushed");
    expect(d.publicDecrypt).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
  it("E5-R16: WrongPhase revert is already-pushed", async () => {
    const { runPush } = await push();
    const wrongPhase = er.describeContractError("WrongPhase", [9n, 2, 3]);
    const d = deps({ send: vi.fn(async () => ({ ok: false as const, error: wrongPhase })) });
    expect((await runPush({ kind: "deal", tableId: 9n, ...d })).result).toBe("alreadyPushed");
  });
  it("E5-R16: zero handle stops the push", async () => {
    const { runPush } = await push();
    const d = deps({ readHandles: vi.fn(async () => [H(21), ZERO_HANDLE]) });
    const out = await runPush({ kind: "deal", tableId: 9n, ...d });
    expect(out.result).not.toBe("pushed");
    expect(d.publicDecrypt).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
  it("E5-R16: wallet errors in plain words", async () => {
    const { runPush } = await push();
    const rejected = er.toTxError(new UserRejectedRequestError(new Error("User rejected the request.")));
    const d = deps({ send: vi.fn(async () => ({ ok: false as const, error: rejected })) });
    const out = await runPush({ kind: "deal", tableId: 9n, ...d });
    expect(out.result).toBe("failed");
    expect(out.message).toEqual(expect.any(String));
    expect(out.message).not.toMatch(/0x[0-9a-f]{8,}/i);
  });
});
