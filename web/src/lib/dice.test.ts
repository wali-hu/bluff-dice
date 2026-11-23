import { describe, expect, it } from "vitest";

import { glyphNoise, HEX_GLYPHS, seededRandom } from "./glyphs";
import { pipCells } from "./pips";

describe("pips", () => {
  it.each([1, 2, 3, 4, 5, 6])("face %i has that many pips inside the 3x3 grid", (face) => {
    const cells = pipCells(face);
    expect(cells).toHaveLength(face);
    expect(new Set(cells).size).toBe(face);
    for (const cell of cells) expect(cell >= 0 && cell <= 8).toBe(true);
  });

  it("rejects faces outside 1..6", () => {
    expect(() => pipCells(0)).toThrow();
    expect(() => pipCells(7)).toThrow();
  });
});

describe("glyph noise", () => {
  it("is deterministic for a seed (server and client render the same first frame)", () => {
    expect(glyphNoise(9, seededRandom(42))).toEqual(glyphNoise(9, seededRandom(42)));
  });

  it("uses hex characters only", () => {
    for (const glyph of glyphNoise(500, seededRandom(7))) expect(HEX_GLYPHS).toContain(glyph);
  });
});
