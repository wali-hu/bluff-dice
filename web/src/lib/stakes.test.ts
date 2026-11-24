import { describe, expect, it } from "vitest";

import {
  CHIP,
  DEFAULT_PLAYERS,
  DEFAULT_STAKE,
  isValidStake,
  payoutSentence,
  potOf,
  validStakes,
  winnerShare,
} from "./stakes";

describe("stakes", () => {
  it("60 chips is 60_000_000 base units (6 decimals) and valid for 2, 3 and 4 players", () => {
    expect(CHIP).toBe(1_000_000n);
    expect(DEFAULT_STAKE).toBe(60_000_000n);
    expect(DEFAULT_PLAYERS).toBe(2);
    for (const n of [2, 3, 4]) expect(isValidStake(DEFAULT_STAKE, n)).toBe(true);
  });

  it("follows the contract rule: > 0, divisible by players - 1, player count 2..4", () => {
    expect(isValidStake(0n, 2)).toBe(false);
    expect(isValidStake(10n * CHIP, 4)).toBe(false); // 10,000,000 % 3 != 0
    expect(isValidStake(30n * CHIP, 4)).toBe(true);
    expect(isValidStake(1n, 3)).toBe(false);
    expect(isValidStake(60n * CHIP, 5)).toBe(false);
    expect(isValidStake(60n * CHIP, 1)).toBe(false);
    expect(isValidStake(2n ** 64n / 4n, 2)).toBe(false);
  });

  it("offers only valid presets per player count", () => {
    for (const n of [2, 3, 4]) for (const s of validStakes(n)) expect(isValidStake(s, n)).toBe(true);
    expect(validStakes(4).map((s) => s / CHIP)).toEqual([30n, 60n, 90n, 120n, 300n]);
    expect(validStakes(2)).toContain(DEFAULT_STAKE);
  });

  it("pot and winner share match BluffDice._settle", () => {
    expect(potOf(DEFAULT_STAKE, 2)).toBe(120_000_000n);
    expect(winnerShare(DEFAULT_STAKE, 2)).toBe(120_000_000n);
    expect(winnerShare(DEFAULT_STAKE, 3)).toBe(90_000_000n);
    expect(winnerShare(DEFAULT_STAKE, 4)).toBe(80_000_000n);
  });

  it("payout sentence: singular for 2 players, plural otherwise", () => {
    const fmt = (v: bigint) => (v / CHIP).toString();
    expect(payoutSentence(DEFAULT_STAKE, 2, fmt)).toBe(
      "Pot 120 chips. The loser pays; the winner gets 120 back (stake included).",
    );
    expect(payoutSentence(DEFAULT_STAKE, 4, fmt)).toBe(
      "Pot 240 chips. The loser pays; each of the 3 winners gets 80 back (stake included).",
    );
  });
});
