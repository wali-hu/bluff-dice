import { describe, expect, it } from "vitest";

import { formatEstimate, PLAY_ESTIMATE, type PlayEstimate } from "./estimate";

describe("estimate", () => {
  it("has positive integer counts", () => {
    for (const key of ["minutes", "transactions", "freeSignatures"] as const) {
      expect(Number.isInteger(PLAY_ESTIMATE[key]), key).toBe(true);
      expect(PLAY_ESTIMATE[key], key).toBeGreaterThan(0);
    }
  });

  it("has a measurement date exactly when it is measured", () => {
    if (PLAY_ESTIMATE.measured) {
      expect(PLAY_ESTIMATE.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } else {
      expect(PLAY_ESTIMATE.measuredOn).toBeNull();
    }
  });

  it("has exactly the documented fields", () => {
    expect(Object.keys(PLAY_ESTIMATE).sort()).toEqual(
      ["freeSignatures", "measured", "measuredOn", "minutes", "transactions"].sort(),
    );
  });

  it("formats singular and plural", () => {
    const e: PlayEstimate = { minutes: 2, transactions: 3, freeSignatures: 1, measured: false, measuredOn: null };
    expect(formatEstimate(e)).toBe("about 2 minutes, 3 transactions + 1 free signature");
    expect(formatEstimate({ ...e, minutes: 1, transactions: 1, freeSignatures: 2 })).toBe(
      "about 1 minute, 1 transaction + 2 free signatures",
    );
  });
});
