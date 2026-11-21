import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { BluffDice } from "../types";
import { DICE_PER_PLAYER, aclOf, decryptDiceAs, deployGame, fullTable } from "./helpers/fixtures";

/**
 * Dice ACL. Rule (from past winners' audits): an encrypted getter is tested by DECRYPTING it as the
 * intended reader and FAILING as everybody else. A non-zero handle only proves a write.
 */
describe("BluffDice: dice ACL", function () {
  let signers: HardhatEthersSigner[];
  let players: HardhatEthersSigner[];
  let outsider: HardhatEthersSigner;
  let game: BluffDice;
  let gameAddress: string;
  let tableId: bigint;

  before(async function () {
    signers = await ethers.getSigners();
    players = signers.slice(0, 4);
    outsider = signers[9];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    game = await deployGame();
    gameAddress = await game.getAddress();
    ({ tableId } = await fullTable(game, players)); // players[3] sends the rolling transaction
  });

  it("every player decrypts their own 5 dice, each in 1..6", async function () {
    for (const p of players) {
      const values = await decryptDiceAs(game, tableId, p, p);
      expect(values).to.have.length(DICE_PER_PLAYER);
      for (const v of values) {
        expect(v).to.be.gte(1n);
        expect(v).to.be.lte(6n);
      }
    }
  });

  // The rejection below is the relayer SDK's ACL pre-check (@zama-fhe/relayer-sdk 0.4.1, lib/node.cjs L3629),
  // which reads the on-chain ACL. On Sepolia the Gateway/KMS enforce the same ACL independently (Phase E test).
  it("another seated player cannot decrypt my die", async function () {
    const [alice, bob] = players;
    const [die] = await game.diceOf(tableId, alice.address);
    await expect(fhevm.userDecryptEuint(FhevmType.euint8, die, gameAddress, bob)).to.be.rejectedWith(
      `User ${bob.address} is not authorized to user decrypt handle ${die}!`,
    );
  });

  it("an outsider cannot decrypt any die", async function () {
    const [die] = await game.diceOf(tableId, players[2].address);
    await expect(fhevm.userDecryptEuint(FhevmType.euint8, die, gameAddress, outsider)).to.be.rejectedWith(
      `User ${outsider.address} is not authorized to user decrypt handle ${die}!`,
    );
  });

  it("ACL: each die is allowed to its owner and the game only, never to the filling joiner or others", async function () {
    const acl = await aclOf(gameAddress);
    const fillingJoiner = players[3]; // sender of the transaction that rolled every die
    for (const owner of players) {
      for (const die of await game.diceOf(tableId, owner.address)) {
        expect(await acl.persistAllowed(die, owner.address)).to.eq(true);
        expect(await acl.persistAllowed(die, gameAddress)).to.eq(true);
        for (const other of [...players, outsider]) {
          if (other === owner) continue;
          expect(await acl.persistAllowed(die, other.address)).to.eq(false);
          expect(await acl.isAllowed(die, other.address)).to.eq(false);
        }
        if (owner !== fillingJoiner) {
          expect(await acl.isAllowed(die, fillingJoiner.address)).to.eq(false);
        }
      }
    }
  });

  it("dice are not publicly decryptable during bidding", async function () {
    const acl = await aclOf(gameAddress);
    const [die] = await game.diceOf(tableId, players[0].address);
    expect(await acl.isAllowedForDecryption(die)).to.eq(false);
    await expect(fhevm.publicDecrypt([die])).to.be.rejectedWith("is not allowed for public decryption");
  });

  it("all 20 handles are initialized and pairwise distinct", async function () {
    const all: string[] = [];
    for (const p of players) all.push(...(await game.diceOf(tableId, p.address)));
    expect(all).to.have.length(4 * DICE_PER_PLAYER);
    for (const h of all) expect(h).to.not.eq(ethers.ZeroHash);
    expect(new Set(all).size).to.eq(all.length);
  });

  it("diceOf reverts NotPlayer for an address without a seat", async function () {
    await expect(game.diceOf(tableId, outsider.address))
      .to.be.revertedWithCustomError(game, "NotPlayer")
      .withArgs(tableId, outsider.address);
  });
});
