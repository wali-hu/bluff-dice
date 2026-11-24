import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkBid, legalFaces, maxQuantity, minLegalQuantity } from "./bidRules";
import fixture from "./bidRules.fixture.json";

const contract = readFileSync(fileURLToPath(new URL("../../../contracts/BluffDice.sol", import.meta.url)), "utf8");

describe("bid rules mirror BluffDice._validateBid", () => {
  it("the contract still has the rules this module mirrors", () => {
    const body = /function _validateBid[\s\S]*?\n {4}\}/.exec(contract)?.[0] ?? "";
    expect(body).toContain("if (face == 0 || face > FACES) revert InvalidFace(face);");
    expect(body).toContain("uint8 maxQuantity = t.playerCount * DICE_PER_PLAYER;");
    expect(body).toContain(
      "if (quantity == 0 || quantity > maxQuantity) revert InvalidQuantity(quantity, maxQuantity);",
    );
    expect(body).toContain("bool raises = quantity > prevQuantity || (quantity == prevQuantity && face > prevFace);");
  });

  it.each(fixture.cases)(
    "$players players, prev $prevQuantity×$prevFace, bid $quantity×$face -> $expect",
    ({ players, prevQuantity, prevFace, quantity, face, expect: expected }) => {
      expect(checkBid({ playerCount: players, prevQuantity, prevFace }, quantity, face)).toBe(expected);
    },
  );

  it("max quantity is players x 5", () => {
    expect(maxQuantity(2)).toBe(10);
    expect(maxQuantity(4)).toBe(20);
  });
});

describe("legal-bid enabling in the picker", () => {
  it("first bid: every face from quantity 1", () => {
    const ctx = { playerCount: 2, prevQuantity: 0, prevFace: 0 };
    expect(minLegalQuantity(ctx)).toBe(1);
    expect(legalFaces(ctx, 1)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("same quantity: only higher faces; higher quantity: every face", () => {
    const ctx = { playerCount: 2, prevQuantity: 3, prevFace: 4 };
    expect(minLegalQuantity(ctx)).toBe(3);
    expect(legalFaces(ctx, 3)).toEqual([5, 6]);
    expect(legalFaces(ctx, 4)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(legalFaces(ctx, 2)).toEqual([]);
  });

  it("after a 6 the same quantity has no face left: the stepper starts one higher", () => {
    expect(minLegalQuantity({ playerCount: 2, prevQuantity: 3, prevFace: 6 })).toBe(4);
  });

  it("at the maximum bid nothing can raise (only LIAR!)", () => {
    const ctx = { playerCount: 2, prevQuantity: 10, prevFace: 6 };
    expect(minLegalQuantity(ctx)).toBeNull();
    expect(legalFaces(ctx, 10)).toEqual([]);
  });
});
