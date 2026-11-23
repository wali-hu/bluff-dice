import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contrastRatio } from "@/lib/contrast";

import { COLORS, CSS_VARS, TEXT_PAIRS, type ColorName } from "./tokens";

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

describe("contrast", () => {
  it("matches known WCAG values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });

  it.each(TEXT_PAIRS)("$fg on $bg ($use) meets WCAG AA", ({ fg, bg, large }) => {
    const ratio = contrastRatio(COLORS[fg], COLORS[bg]);
    expect(ratio).toBeGreaterThanOrEqual(large ? AA_LARGE : AA_NORMAL);
  });
});

describe("CSS tokens", () => {
  const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");

  it.each(Object.keys(COLORS) as ColorName[])("%s is declared on :root with the same value", (name) => {
    const match = new RegExp(`${CSS_VARS[name]}:\\s*(#[0-9a-fA-F]{6});`).exec(css);
    expect(match?.[1]?.toLowerCase()).toBe(COLORS[name].toLowerCase());
  });

  it("gives the body an explicit background", () => {
    expect(css).toMatch(/body\s*{[^}]*background-color:\s*var\(--ink\)/);
  });
});
