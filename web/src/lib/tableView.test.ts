import { describe, expect, it } from "vitest";

import { NO_SEAT, Phase } from "@/chain/reads";

import {
  deadlineRing,
  formatSeconds,
  hasZeroHandle,
  paidLabel,
  pushGasNote,
  settledSummary,
  tableActions,
  type ActionInput,
} from "./tableView";

const NOW = 1_764_000_000n;
const bidding: ActionInput = {
  phase: Phase.Bidding,
  mySeat: 1,
  turnSeat: 1,
  playerCount: 2,
  bidQuantity: 3,
  bidFace: 4,
  deadline: NOW + 100n,
  nowSeconds: NOW,
  canWrite: true,
  pendingTx: false,
};

describe("actions per (phase, seat, turn, deadline, viewer)", () => {
  it("my turn before the deadline: bid and LIAR!", () => {
    expect(tableActions(bidding)).toMatchObject({ bid: true, liar: true, claimTimeout: false, waitingForTurn: false });
  });

  it("opening bid: no LIAR! without a bid", () => {
    expect(tableActions({ ...bidding, bidQuantity: 0, bidFace: 0 })).toMatchObject({
      bid: true,
      liar: false,
      liarReason: "No bid to challenge yet",
    });
  });

  it("someone else's turn: wait", () => {
    expect(tableActions({ ...bidding, turnSeat: 0 })).toMatchObject({ bid: false, liar: false, waitingForTurn: true });
  });

  it("at the deadline second it is still my turn; one second later anyone may claim the timeout", () => {
    expect(tableActions({ ...bidding, deadline: NOW }).bid).toBe(true);
    const late = tableActions({ ...bidding, deadline: NOW - 1n });
    expect(late).toMatchObject({ bid: false, liar: false, claimTimeout: true, waitingForTurn: false });
    expect(tableActions({ ...bidding, deadline: NOW - 1n, mySeat: NO_SEAT }).claimTimeout).toBe(true);
  });

  it("spectators never bid, but can push", () => {
    expect(tableActions({ ...bidding, mySeat: NO_SEAT })).toMatchObject({
      bid: false,
      liar: false,
      waitingForTurn: true,
    });
    expect(tableActions({ ...bidding, mySeat: NO_SEAT, phase: Phase.AwaitingPaidProof }).deal).toBe(true);
    expect(tableActions({ ...bidding, mySeat: NO_SEAT, phase: Phase.AwaitingReveal }).reveal).toBe(true);
  });

  it("no wallet (or wrong network): nothing to send", () => {
    const a = tableActions({ ...bidding, canWrite: false, deadline: NOW - 1n });
    expect([a.bid, a.liar, a.claimTimeout, a.deal, a.reveal]).toEqual([false, false, false, false, false]);
  });

  it("other phases: no bidding actions", () => {
    for (const phase of [
      Phase.Joining,
      Phase.AwaitingPaidProof,
      Phase.AwaitingReveal,
      Phase.Settled,
      Phase.Cancelled,
    ]) {
      const a = tableActions({ ...bidding, phase });
      expect([a.bid, a.liar, a.claimTimeout, a.waitingForTurn]).toEqual([false, false, false, false]);
    }
  });
});

describe("deadline ring", () => {
  it("turn: 300 s period", () => {
    expect(deadlineRing(Phase.Bidding, NOW + 150n, NOW)).toEqual({
      secondsLeft: 150,
      fraction: 0.5,
      expired: false,
      label: "2:30",
    });
  });

  it("proof deadline: 1 h period, expired clamps to 0", () => {
    expect(deadlineRing(Phase.AwaitingReveal, NOW + 1800n, NOW)?.fraction).toBe(0.5);
    expect(deadlineRing(Phase.AwaitingPaidProof, NOW - 5n, NOW)).toMatchObject({
      secondsLeft: 0,
      fraction: 0,
      expired: true,
    });
  });

  it("no ring outside timed phases or without a deadline", () => {
    expect(deadlineRing(Phase.Joining, NOW + 5n, NOW)).toBeNull();
    expect(deadlineRing(Phase.Settled, NOW + 5n, NOW)).toBeNull();
    expect(deadlineRing(Phase.Bidding, 0n, NOW)).toBeNull();
  });

  it("formats", () => {
    expect(formatSeconds(42)).toBe("42 s");
    expect(formatSeconds(65)).toBe("1:05");
    expect(formatSeconds(3720)).toBe("1 h 2 min");
  });
});

describe("push helpers", () => {
  it("gas note and zero handles", () => {
    expect(pushGasNote("deal", 2)).toContain("4.6M");
    expect(pushGasNote("deal", 4)).toContain("8.9M");
    expect(pushGasNote("reveal", 2)).toContain("1.4M");
    expect(hasZeroHandle([`0x${"00".repeat(32)}`])).toBe(true);
    expect(hasZeroHandle([`0x${"ab".repeat(32)}`])).toBe(false);
  });
});

describe("seats and result", () => {
  it("never labels anyone 'no chips'", () => {
    for (const phase of Object.values(Phase)) expect(paidLabel(phase).toLowerCase()).not.toContain("no chips");
    expect(paidLabel(Phase.Joining)).toContain("hidden until the table is full");
  });

  const name = (s: number) => `seat ${s + 1}`;
  it("revealed: true bid -> the caller lost", () => {
    const s = settledSummary(
      { liarCallerSeat: 1, bidderSeat: 0, loserSeat: 1, revealedCount: 4, bidQuantity: 3, bidFace: 5 },
      name,
    );
    expect(s).toMatchObject({ kind: "revealed", bidTrue: true, loserSeat: 1 });
    expect(s.kind === "revealed" && s.text).toContain("4 dice show 5");
  });

  it("revealed: false bid -> the bidder lost; timeout; unknown", () => {
    expect(
      settledSummary(
        { liarCallerSeat: 1, bidderSeat: 0, loserSeat: 0, revealedCount: 2, bidQuantity: 3, bidFace: 5 },
        name,
      ),
    ).toMatchObject({ bidTrue: false });
    expect(
      settledSummary(
        { liarCallerSeat: NO_SEAT, bidderSeat: 0, loserSeat: 1, revealedCount: 0, bidQuantity: 3, bidFace: 5 },
        name,
      ).kind,
    ).toBe("timeout");
    expect(
      settledSummary(
        {
          liarCallerSeat: NO_SEAT,
          bidderSeat: NO_SEAT,
          loserSeat: NO_SEAT,
          revealedCount: 0,
          bidQuantity: 0,
          bidFace: 0,
        },
        name,
      ).kind,
    ).toBe("unknown");
  });
});
