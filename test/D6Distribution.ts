import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { D6Harness, D6Harness__factory } from "../types";

/**
 * Distribution of `D6.roll()` (multiply-shift on 32 random bits).
 *
 * What this test can and cannot show:
 * - Mock randomness comes from `ethers.randomBytes` (the seed is ignored), so this checks OUR
 *   32-bit -> 1..6 mapping, not the real coprocessor RNG.
 * - 1,000 dice only catch gross mapping bugs (wrong range, a missing or doubled face). Even the 1.6% skew
 *   of `rem(randEuint8(), 6)` would not be detected at this size. The bias bound (every face within
 *   1.6e-10 of 1/6) is proven analytically, not by this test.
 * - Chi-square, 5 degrees of freedom, alpha = 1e-4: critical value 25.745. A correct mapping fails
 *   about once per 10,000 runs; if it ever fails, rerun once before investigating.
 */
const TOTAL_DICE = 1000;
const BATCH = 25; // 25 x 507,064 = 12.7M HCU, under the 20M per-tx limit
const CHI_SQUARE_CRITICAL_DF5_ALPHA_1E4 = 25.745;
const HCU_PER_DIE = 507_064;

describe("D6: distribution and cost", function () {
  let harness: D6Harness;

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    const factory = (await ethers.getContractFactory("D6Harness")) as D6Harness__factory;
    harness = (await factory.deploy()) as D6Harness;
    await harness.waitForDeployment();
  });

  it(`${TOTAL_DICE} dice: all in 1..6, every face seen, chi-square < ${CHI_SQUARE_CRITICAL_DF5_ALPHA_1E4}`, async function () {
    this.timeout(600_000);
    for (let i = 0; i < TOTAL_DICE / BATCH; i++) {
      await (await harness.rollMany(BATCH)).wait();
    }
    expect(await harness.diceCount()).to.eq(BigInt(TOTAL_DICE));

    const handles = await harness.diceRange(0, TOTAL_DICE);
    const counts = [0, 0, 0, 0, 0, 0];
    for (const h of handles) {
      // Mock-only ACL bypass: this test is about the mapping, not about who may decrypt.
      const v = Number(await fhevm.debugger.decryptEuint(FhevmType.euint8, h));
      expect(v).to.be.gte(1);
      expect(v).to.be.lte(6);
      counts[v - 1]++;
    }

    const expected = TOTAL_DICE / 6;
    const chiSquare = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    console.log(`      face counts 1..6: ${counts.join(", ")}  chi-square = ${chiSquare.toFixed(3)}`);

    for (const c of counts) expect(c).to.be.gt(0);
    expect(chiSquare).to.be.lt(CHI_SQUARE_CRITICAL_DF5_ALPHA_1E4);
  });

  it(`one die costs exactly ${HCU_PER_DIE} HCU (locks the formula's op list)`, async function () {
    const receipt = await (await harness.rollMany(1)).wait();
    const hcu = fhevm.computeTransactionHCU(receipt!);
    expect(hcu.globalHCU).to.eq(HCU_PER_DIE);
    expect(hcu.maxHCUDepth).to.eq(HCU_PER_DIE);
  });
});
