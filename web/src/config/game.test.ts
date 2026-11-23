import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DICE_PER_PLAYER, FACES, MAX_PLAYERS, MIN_PLAYERS, PROOF_TIMEOUT_SECONDS } from "./game";

const source = readFileSync(fileURLToPath(new URL("../../../contracts/BluffDice.sol", import.meta.url)), "utf8");

function constant(name: string): string {
  const match = new RegExp(`constant ${name} = ([^;]+);`).exec(source);
  if (!match?.[1]) throw new Error(`${name} not found in BluffDice.sol`);
  return match[1].trim();
}

describe("game constants match BluffDice.sol", () => {
  it("players, dice and faces", () => {
    expect(Number(constant("MIN_PLAYERS"))).toBe(MIN_PLAYERS);
    expect(Number(constant("MAX_PLAYERS"))).toBe(MAX_PLAYERS);
    expect(Number(constant("DICE_PER_PLAYER"))).toBe(DICE_PER_PLAYER);
    expect(Number(constant("FACES"))).toBe(FACES);
  });

  it("proof timeout", () => {
    expect(constant("PROOF_TIMEOUT")).toBe("1 hours");
    expect(PROOF_TIMEOUT_SECONDS).toBe(3600);
  });
});
