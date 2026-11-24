import { describe, expect, it } from "vitest";

import { Phase } from "@/chain/reads";

import { PHASE_NAMES, roomView } from "./tableRoom";

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
