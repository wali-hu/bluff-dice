import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { BluffDice } from "../types";
import {
  KMS_ERRORS,
  Phase,
  countFace,
  decryptAll,
  deployGame,
  fullTable,
  joinWords,
  playToLiar,
  revealProof,
  word,
  words,
} from "./helpers/fixtures";

/**
 * Every way a submitted reveal can be wrong. The proof is the only authority and the handle list is always
 * rebuilt from storage, so each case must revert and leave the table exactly as it was (AwaitingReveal),
 * and a valid proof must still settle the same table afterwards: no bad submission can brick a round.
 *
 * KMS errors (`KMSInvalidSigner`, ...) come from the coprocessor's KMSVerifier, not from our ABI. A changed
 * message makes ecrecover return some other address, which is not a KMS signer: that is why a wrong value,
 * a wrong order or wrong handles all surface as `KMSInvalidSigner(address)`, not as `InvalidKMSSignatures()`.
 */
describe("BluffDice: reveal proofs that must be rejected", function () {
  let signers: HardhatEthersSigner[];
  let outsider: HardhatEthersSigner;
  let game: BluffDice;

  before(async function () {
    signers = await ethers.getSigners();
    outsider = signers[9];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This hardhat test suite cannot run on Sepolia Testnet");
      this.skip();
    }
    game = await deployGame();
  });

  /** A table of `n` in AwaitingReveal (seat 0 bid one die of its own first face, seat 1 called Liar). */
  async function liarTable(n: number, players = signers.slice(0, n)) {
    const { tableId } = await fullTable(game, players);
    const values = await decryptAll(game, tableId);
    const face = Number(values[0]);
    await playToLiar(game, tableId, players, 1, face);
    return { tableId, values, face, ...(await revealProof(game, tableId)) };
  }

  async function snapshot(tableId: bigint) {
    const t = await game.getTable(tableId);
    return [t.phase, t.loserSeat, t.revealedCount, t.liarCallerSeat, t.deadline].map(String);
  }

  /** The table is untouched and the real proof still settles it, with the right count. */
  async function expectUnchangedAndStillFinalizable(
    tableId: bigint,
    before: string[],
    real: { abiEncodedClearValues: string; decryptionProof: string; values: bigint[]; face: number },
  ) {
    expect(await snapshot(tableId)).to.deep.eq(before);
    expect((await game.getTable(tableId)).phase).to.eq(Phase.AwaitingReveal);
    await expect(game.finalizeReveal(tableId, real.abiEncodedClearValues, real.decryptionProof)).to.emit(
      game,
      "RoundRevealed",
    );
    const t = await game.getTable(tableId);
    expect(t.phase).to.eq(Phase.Settled);
    expect(t.revealedCount).to.eq(countFace(real.values, real.face));
  }

  it("swapped order (A): two different clear words swapped, original proof -> KMSInvalidSigner", async function () {
    const x = await liarTable(2);
    const ws = words(x.abiEncodedClearValues);
    const j = ws.findIndex((w) => w !== ws[0]);
    expect(j, "test needs two dice with different values").to.be.greaterThan(0);
    [ws[0], ws[j]] = [ws[j], ws[0]];
    const before = await snapshot(x.tableId);
    await expect(game.finalizeReveal(x.tableId, joinWords(ws), x.decryptionProof)).to.be.revertedWithCustomError(
      KMS_ERRORS,
      "KMSInvalidSigner",
    );
    await expectUnchangedAndStillFinalizable(x.tableId, before, x);
  });

  it("swapped order (B): a proof made for a permuted handle list -> KMSInvalidSigner (storage order wins)", async function () {
    const x = await liarTable(3);
    const permuted = [...x.handles];
    [permuted[0], permuted[permuted.length - 1]] = [permuted[permuted.length - 1], permuted[0]];
    const r = await fhevm.publicDecrypt(permuted);
    const before = await snapshot(x.tableId);
    await expect(
      game.finalizeReveal(x.tableId, r.abiEncodedClearValues, r.decryptionProof),
    ).to.be.revertedWithCustomError(KMS_ERRORS, "KMSInvalidSigner");
    await expectUnchangedAndStillFinalizable(x.tableId, before, x);
  });

  it("tampered value: one die changed to another valid face -> KMSInvalidSigner", async function () {
    const x = await liarTable(2);
    const ws = words(x.abiEncodedClearValues);
    ws[3] = word((x.values[3] % 6n) + 1n);
    const before = await snapshot(x.tableId);
    await expect(game.finalizeReveal(x.tableId, joinWords(ws), x.decryptionProof)).to.be.revertedWithCustomError(
      KMS_ERRORS,
      "KMSInvalidSigner",
    );
    await expectUnchangedAndStillFinalizable(x.tableId, before, x);
  });

  it("the cheater's dream: every die = the bid face -> KMSInvalidSigner", async function () {
    const x = await liarTable(4);
    const dream = joinWords(x.handles.map(() => word(x.face)));
    expect(dream, "tampered bytes must differ from the real ones").to.not.eq(x.abiEncodedClearValues);
    const before = await snapshot(x.tableId);
    await expect(game.finalizeReveal(x.tableId, dream, x.decryptionProof)).to.be.revertedWithCustomError(
      KMS_ERRORS,
      "KMSInvalidSigner",
    );
    await expectUnchangedAndStillFinalizable(x.tableId, before, x);
  });

  it("another table's proof, same size (3 vs 3 players) -> KMSInvalidSigner", async function () {
    const a = await liarTable(3);
    const b = await liarTable(3, signers.slice(3, 6));
    const before = await snapshot(a.tableId);
    await expect(
      game.finalizeReveal(a.tableId, b.abiEncodedClearValues, b.decryptionProof),
    ).to.be.revertedWithCustomError(KMS_ERRORS, "KMSInvalidSigner");
    await expectUnchangedAndStillFinalizable(a.tableId, before, a);
  });

  it("another table's proof, different size (2-player proof on a 4-player table) -> InvalidCleartextsLength", async function () {
    const small = await liarTable(2);
    const big = await liarTable(4);
    const before = await snapshot(big.tableId);
    await expect(game.finalizeReveal(big.tableId, small.abiEncodedClearValues, small.decryptionProof))
      .to.be.revertedWithCustomError(game, "InvalidCleartextsLength")
      .withArgs(20 * 32, 10 * 32);
    await expectUnchangedAndStillFinalizable(big.tableId, before, big);
  });

  // v1 has one round per table, so "a previous round" can only be a finished table with the same players in
  // the same seats. `round` is NOT part of the replay guard: what binds a proof to its round is that every
  // roll creates fresh handles. If multi-round is ever added, this becomes a real round-2 test.
  it("proof from a finished table (stand-in for a previous round), same players and seats -> KMSInvalidSigner", async function () {
    const players = signers.slice(0, 3);
    const old = await liarTable(3, players);
    await game.finalizeReveal(old.tableId, old.abiEncodedClearValues, old.decryptionProof);
    expect((await game.getTable(old.tableId)).phase).to.eq(Phase.Settled);

    const fresh = await liarTable(3, players);
    const oldSet = new Set(old.handles);
    for (const h of fresh.handles) expect(oldSet.has(h), "handles of two rolls must be disjoint").to.eq(false);

    const before = await snapshot(fresh.tableId);
    await expect(
      game.finalizeReveal(fresh.tableId, old.abiEncodedClearValues, old.decryptionProof),
    ).to.be.revertedWithCustomError(KMS_ERRORS, "KMSInvalidSigner");
    await expectUnchangedAndStillFinalizable(fresh.tableId, before, fresh);
  });

  it("double submit: the same valid calldata again, from anyone -> WrongPhase; result unchanged", async function () {
    const x = await liarTable(2);
    await game.finalizeReveal(x.tableId, x.abiEncodedClearValues, x.decryptionProof);
    const after = await snapshot(x.tableId);
    for (const sender of [signers[0], outsider]) {
      await expect(game.connect(sender).finalizeReveal(x.tableId, x.abiEncodedClearValues, x.decryptionProof))
        .to.be.revertedWithCustomError(game, "WrongPhase")
        .withArgs(x.tableId, Phase.AwaitingReveal, Phase.Settled);
    }
    expect(await snapshot(x.tableId)).to.deep.eq(after);
  });

  it("empty proof with correct-length cleartexts -> EmptyDecryptionProof", async function () {
    const x = await liarTable(2);
    const before = await snapshot(x.tableId);
    await expect(game.finalizeReveal(x.tableId, x.abiEncodedClearValues, "0x")).to.be.revertedWithCustomError(
      KMS_ERRORS,
      "EmptyDecryptionProof",
    );
    await expectUnchangedAndStillFinalizable(x.tableId, before, x);
  });

  // Proof layout: uint8 numSigners || numSigners x 65-byte signature || extraData. The mock proof is
  // 0x01 || sig || 0x00 (67 bytes). Error names below were observed in mock, not assumed.
  it("truncated proofs: last byte cut -> KMSInvalidSigner; cut inside the signature -> DeserializingDecryptionProofFail", async function () {
    const x = await liarTable(2);
    const proof = x.decryptionProof;
    expect((proof.length - 2) / 2).to.eq(1 + 65 + 1);
    const before = await snapshot(x.tableId);

    // extraData is part of the signed digest: dropping it changes the recovered signer.
    await expect(
      game.finalizeReveal(x.tableId, x.abiEncodedClearValues, proof.slice(0, -2)),
    ).to.be.revertedWithCustomError(KMS_ERRORS, "KMSInvalidSigner");
    // Fewer bytes than 1 + 65 * numSigners.
    await expect(
      game.finalizeReveal(x.tableId, x.abiEncodedClearValues, proof.slice(0, 2 + 65 * 2)),
    ).to.be.revertedWithCustomError(KMS_ERRORS, "DeserializingDecryptionProofFail");
    await expectUnchangedAndStillFinalizable(x.tableId, before, x);
  });

  it("numSigners = 0 -> KMSZeroSignature; numSigners = 2 with one signature -> DeserializingDecryptionProofFail", async function () {
    const x = await liarTable(2);
    const sig = x.decryptionProof.slice(4, 4 + 130);
    const extra = x.decryptionProof.slice(4 + 130);
    const before = await snapshot(x.tableId);
    await expect(game.finalizeReveal(x.tableId, x.abiEncodedClearValues, "0x00" + extra)).to.be.revertedWithCustomError(
      KMS_ERRORS,
      "KMSZeroSignature",
    );
    await expect(
      game.finalizeReveal(x.tableId, x.abiEncodedClearValues, "0x02" + sig + extra),
    ).to.be.revertedWithCustomError(KMS_ERRORS, "DeserializingDecryptionProofFail");
    await expectUnchangedAndStillFinalizable(x.tableId, before, x);
  });

  // Observation, not a vulnerability: with the mock's threshold of 1 the first valid signature is enough, so a
  // duplicated copy of it is never examined. On a threshold-t network a duplicate counts once (transient set).
  it("duplicated signature (0x02 || sig || sig || extraData) is accepted in mock (threshold 1)", async function () {
    const x = await liarTable(2);
    const sig = x.decryptionProof.slice(4, 4 + 130);
    const extra = x.decryptionProof.slice(4 + 130);
    await expect(game.finalizeReveal(x.tableId, x.abiEncodedClearValues, "0x02" + sig + sig + extra)).to.emit(
      game,
      "RoundRevealed",
    );
  });

  describe("cleartexts length (checked before the KMS call)", function () {
    it("n*32 - 32, n*32 + 32, n*32 + 1 and 0 bytes -> InvalidCleartextsLength(expected, actual)", async function () {
      const x = await liarTable(2);
      const expected = 10 * 32;
      const ct = x.abiEncodedClearValues;
      const cases: [string, number][] = [
        ["0x" + ct.slice(2, 2 + (expected - 32) * 2), expected - 32],
        [ct + "00".repeat(32), expected + 32],
        [ct + "00", expected + 1],
        ["0x", 0],
      ];
      const before = await snapshot(x.tableId);
      for (const [bytes, actual] of cases) {
        await expect(game.finalizeReveal(x.tableId, bytes, x.decryptionProof))
          .to.be.revertedWithCustomError(game, "InvalidCleartextsLength")
          .withArgs(expected, actual);
      }
      await expectUnchangedAndStillFinalizable(x.tableId, before, x);
    });

    it("the abi.encode(uint256[]) trap (offset + length words) -> InvalidCleartextsLength", async function () {
      const x = await liarTable(3);
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [x.values]);
      expect((encoded.length - 2) / 2).to.eq(15 * 32 + 64);
      const before = await snapshot(x.tableId);
      await expect(game.finalizeReveal(x.tableId, encoded, x.decryptionProof))
        .to.be.revertedWithCustomError(game, "InvalidCleartextsLength")
        .withArgs(15 * 32, 15 * 32 + 64);
      await expectUnchangedAndStillFinalizable(x.tableId, before, x);
    });

    it("a valid proof for a subset (seat 0's 5 dice only) -> InvalidCleartextsLength", async function () {
      const x = await liarTable(2);
      const subset = await fhevm.publicDecrypt(x.handles.slice(0, 5));
      const before = await snapshot(x.tableId);
      await expect(game.finalizeReveal(x.tableId, subset.abiEncodedClearValues, subset.decryptionProof))
        .to.be.revertedWithCustomError(game, "InvalidCleartextsLength")
        .withArgs(10 * 32, 5 * 32);
      await expectUnchangedAndStillFinalizable(x.tableId, before, x);
    });
  });
});
