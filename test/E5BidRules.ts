import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, fhevm } from "hardhat";

import { BluffDice } from "../types";
import { deployGame, fullTable } from "./helpers/fixtures";

interface BidCase {
  name: string;
  prev: [number, number];
  bid: [number, number];
  expect: "ok" | "BidNotHigher" | "InvalidFace" | "InvalidQuantity";
}

// The same case table the web app's spec test runs (E5-R4): the app's bid rule must be the contract's bid rule.
const shared = JSON.parse(readFileSync(join(__dirname, "..", "web", "src", "spec", "e5-bid-cases.json"), "utf8")) as {
  playerCount: number;
  cases: BidCase[];
};

describe("E5-R4: BluffDice.bid on the shared case table", function () {
  let signers: HardhatEthersSigner[];
  let game: BluffDice;

  before(async function () {
    signers = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    game = await deployGame();
  });

  for (const c of shared.cases) {
    it(`E5-R4: app and contract agree on the shared case table (${c.name})`, async function () {
      const players = signers.slice(0, shared.playerCount);
      const { tableId } = await fullTable(game, players);
      // Seat 0 opens. With a previous bid, seat 0 places it and seat 1 makes the tested bid.
      let bidder = players[0];
      if (c.prev[0] !== 0) {
        await (await game.connect(players[0]).bid(tableId, c.prev[0], c.prev[1])).wait();
        bidder = players[1];
      }
      const tx = game.connect(bidder).bid(tableId, c.bid[0], c.bid[1]);
      if (c.expect === "ok") {
        await expect(tx).to.emit(game, "BidPlaced");
      } else {
        await expect(tx).to.be.revertedWithCustomError(game, c.expect);
      }
    });
  }
});
