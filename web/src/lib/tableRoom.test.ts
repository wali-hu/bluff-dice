import { describe, expect, it } from "vitest";

import { Phase } from "@/chain/reads";

import { CANCELLED_TEXT, cancelState, PHASE_NAMES, roomView } from "./tableRoom";

describe("roomView", () => {
  it("maps every contract phase", () => {
    expect(roomView(Phase.Joining).kind).toBe("waiting");
    expect(roomView(Phase.AwaitingPaidProof).kind).toBe("checkingStakes");
    expect(roomView(Phase.Bidding).kind).toBe("inProgress");
    expect(roomView(Phase.AwaitingReveal).kind).toBe("inProgress");
    expect(roomView(Phase.Settled).kind).toBe("over");
    expect(roomView(Phase.Cancelled).kind).toBe("over");
    expect(roomView(Phase.None).kind).toBe("notFound");
    expect(roomView(99).kind).toBe("notFound");
  });

  it("names every phase", () => {
    for (const value of Object.values(Phase)) expect(PHASE_NAMES[value].length).toBeGreaterThan(0);
  });
});

describe("cancelState (BluffDice.cancel)", () => {
  it("is only offered while a proof is awaited", () => {
    expect(cancelState(Phase.Joining, 0n, 100n)).toEqual({ kind: "none" });
    expect(cancelState(Phase.Bidding, 50n, 100n)).toEqual({ kind: "none" });
    expect(cancelState(Phase.Cancelled, 50n, 100n)).toEqual({ kind: "none" });
  });

  it("waits until block.timestamp > deadline (strict, as in the contract)", () => {
    expect(cancelState(Phase.AwaitingPaidProof, 100n, 100n)).toEqual({ kind: "wait", deadline: 100n });
    expect(cancelState(Phase.AwaitingPaidProof, 100n, 101n)).toEqual({ kind: "available" });
    expect(cancelState(Phase.AwaitingReveal, 100n, 101n)).toEqual({ kind: "available" });
  });
});

describe("over copy", () => {
  it("cancelled tables say every stake was refunded", () => {
    expect(roomView(Phase.Cancelled)).toEqual({ kind: "over", text: "Cancelled: every stake was refunded." });
    expect(CANCELLED_TEXT).toBe("Cancelled: every stake was refunded.");
    const settled = roomView(Phase.Settled);
    expect(settled.kind === "over" && settled.text).not.toContain("refunded");
  });
});
