import { describe, expect, it } from "vitest";

import { formatChips } from "./chips";

describe("formatChips", () => {
  it("formats 6-decimal base units", () => {
    expect(formatChips(1_000_000_000n)).toBe("1,000");
    expect(formatChips(60_000_000n)).toBe("60");
    expect(formatChips(1_500_000n)).toBe("1.5");
    expect(formatChips(0n)).toBe("0");
    expect(formatChips(1n)).toBe("0.000001");
    expect(formatChips(1_234_567_890_000n)).toBe("1,234,567.89");
  });
});
