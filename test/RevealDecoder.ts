import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { RevealDecoderHarness } from "../types";
import { countFace, joinWords, word } from "./helpers/fixtures";

/**
 * `RevealDecoder.countFace` through a test harness. A real KMS proof can only carry values the D6 roll
 * produced (1..6), so the range check is only reachable with hand-made words.
 */
describe("RevealDecoder", function () {
  let decoder: RevealDecoderHarness;

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    decoder = (await (await ethers.getContractFactory("RevealDecoderHarness")).deploy()) as RevealDecoderHarness;
    await decoder.waitForDeployment();
  });

  for (const n of [10, 15, 20]) {
    it(`n = ${n}: the count matches a JS recount for every face`, async function () {
      // Deterministic spread over 1..6 with repeats.
      const values = Array.from({ length: n }, (_, i) => BigInt(((i * 7 + 3) % 6) + 1));
      const bytes = joinWords(values.map(word));
      for (let face = 1; face <= 6; ++face) {
        expect(await decoder.countFace(bytes, n, face)).to.eq(countFace(values, face));
      }
    });
  }

  it("n = 20, all dice equal: the count is 20 for that face and 0 for the others", async function () {
    const bytes = joinWords(Array.from({ length: 20 }, () => word(4)));
    expect(await decoder.countFace(bytes, 20, 4)).to.eq(20);
    expect(await decoder.countFace(bytes, 20, 3)).to.eq(0);
  });

  const bad: [string, bigint][] = [
    ["0", 0n],
    ["7", 7n],
    ["2^8 + 3 (high byte set, low byte is a valid face)", 2n ** 8n + 3n],
    ["2^255 + 1 (top bit set)", 2n ** 255n + 1n],
  ];
  for (const [label, value] of bad) {
    it(`a word of ${label} reverts InvalidDieValue(index, value) with exact arguments`, async function () {
      const values = [1n, 2n, 3n, 4n, 5n, 6n, 1n, 2n, 3n, 4n];
      const index = 6;
      const ws = values.map(word);
      ws[index] = word(value);
      await expect(decoder.countFace(joinWords(ws), values.length, 1))
        .to.be.revertedWithCustomError(decoder, "InvalidDieValue")
        .withArgs(index, value);
    });
  }
});
