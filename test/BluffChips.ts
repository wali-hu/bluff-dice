import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { BluffChips, BluffChips__factory } from "../types";
import { FAUCET_AMOUNT, chipBalance } from "./helpers/fixtures";

const DAY = 24n * 60n * 60n;
/** ERC-7984 interface id (spec and OZ 0.5.3). */
const IERC7984_ID = "0x4958f2a4";

describe("BluffChips (BCHIP)", function () {
  let signers: HardhatEthersSigner[];
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let token: BluffChips;

  before(async function () {
    signers = await ethers.getSigners();
    [owner, alice, bob] = signers;
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    const factory = (await ethers.getContractFactory("BluffChips")) as BluffChips__factory;
    token = (await factory.deploy(owner.address)) as BluffChips;
    await token.waitForDeployment();
  });

  it("metadata: name, symbol, 6 decimals, ERC-7984 interface id, owner", async function () {
    expect(await token.name()).to.eq("Bluff Chips");
    expect(await token.symbol()).to.eq("BCHIP");
    expect(await token.decimals()).to.eq(6);
    expect(await token.supportsInterface(IERC7984_ID)).to.eq(true);
    expect(await token.owner()).to.eq(owner.address);
    expect(await token.FAUCET_AMOUNT()).to.eq(FAUCET_AMOUNT);
  });

  it("faucet mints 1,000 chips; only the claimant can decrypt the balance", async function () {
    await (await token.connect(alice).faucet()).wait();
    expect(await chipBalance(token, alice)).to.eq(FAUCET_AMOUNT);
    expect(await token.lastFaucet(alice.address)).to.eq(await time.latest());

    const h = await token.confidentialBalanceOf(alice.address);
    await expect(chipBalance(token, alice, bob)).to.be.rejectedWith(
      `User ${bob.address} is not authorized to user decrypt handle ${h}!`,
    );
  });

  it("cooldown: a second claim 1 s before 24 h reverts FaucetCooldown(next); at 24 h it succeeds", async function () {
    await (await token.connect(alice).faucet()).wait();
    const next = BigInt(await time.latest()) + DAY;

    await time.setNextBlockTimestamp(next - 1n);
    await expect(token.connect(alice).faucet()).to.be.revertedWithCustomError(token, "FaucetCooldown").withArgs(next);

    await time.setNextBlockTimestamp(next);
    await (await token.connect(alice).faucet()).wait();
    expect(await chipBalance(token, alice)).to.eq(2n * FAUCET_AMOUNT);
  });

  it("the cooldown is per address", async function () {
    await (await token.connect(alice).faucet()).wait();
    await (await token.connect(bob).faucet()).wait();
    expect(await chipBalance(token, bob)).to.eq(FAUCET_AMOUNT);
  });

  it("the owner can mint to any address; anyone else reverts OwnableUnauthorizedAccount", async function () {
    await (await token.connect(owner).mint(bob.address, 1234n)).wait();
    expect(await chipBalance(token, bob)).to.eq(1234n);
    await expect(token.connect(alice).mint(alice.address, 1n))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
  });
});
