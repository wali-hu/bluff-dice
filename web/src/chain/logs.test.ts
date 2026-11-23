import { describe, expect, it } from "vitest";

import { chunkRanges, MAX_LOG_SPAN } from "./logs";

describe("chunkRanges", () => {
  it("never exceeds 50,000 blocks per range and covers the whole span", () => {
    const ranges = chunkRanges(12_183_614n, 12_300_000n);
    for (const r of ranges) expect(r.toBlock - r.fromBlock + 1n).toBeLessThanOrEqual(MAX_LOG_SPAN);
    expect(ranges[0]?.fromBlock).toBe(12_183_614n);
    expect(ranges.at(-1)?.toBlock).toBe(12_300_000n);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]?.fromBlock).toBe((ranges[i - 1]?.toBlock ?? 0n) + 1n);
  });

  it("returns newest first when asked", () => {
    const ranges = chunkRanges(0n, 120_000n, { newestFirst: true });
    expect(ranges.map((r) => [r.fromBlock, r.toBlock])).toEqual([
      [100_000n, 120_000n],
      [50_000n, 99_999n],
      [0n, 49_999n],
    ]);
  });

  it("handles a single block and an empty range", () => {
    expect(chunkRanges(5n, 5n)).toEqual([{ fromBlock: 5n, toBlock: 5n }]);
    expect(chunkRanges(6n, 5n)).toEqual([]);
  });

  it("rejects a non-positive span", () => {
    expect(() => chunkRanges(0n, 10n, { span: 0n })).toThrow();
  });
});
