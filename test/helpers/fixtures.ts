import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ContractTransactionReceipt } from "ethers";
import { ethers, fhevm } from "hardhat";

import { BluffDice, BluffDice__factory } from "../../types";

/** Mirrors `BluffDice.Phase`. */
export enum Phase {
  None,
  Joining,
  AwaitingPaidProof,
  Bidding,
  AwaitingReveal,
  Settled,
  Cancelled,
}

export const NO_SEAT = 255;
export const DICE_PER_PLAYER = 5;
export const BID_TIMEOUT = 300n;
/** Divisible by 1, 2 and 3, so it is a valid stake for 2, 3 and 4 seats. */
export const STAKE = 600n;
/** EIP-7825 per-transaction gas cap, enforced on Sepolia since Fusaka. */
export const TX_GAS_CAP = 16_777_216n;

export async function deployGame(bidTimeout: bigint = BID_TIMEOUT): Promise<BluffDice> {
  const factory = (await ethers.getContractFactory("BluffDice")) as BluffDice__factory;
  const game = (await factory.deploy(bidTimeout)) as BluffDice;
  await game.waitForDeployment();
  return game;
}

/** Creates a table with `players[0]` as creator; returns its id. */
export async function createTable(
  game: BluffDice,
  creator: HardhatEthersSigner,
  maxPlayers: number,
  stake: bigint = STAKE,
): Promise<bigint> {
  const tableId = await game.nextTableId();
  await (await game.connect(creator).createTable(stake, maxPlayers)).wait();
  return tableId;
}

/**
 * Creates a table of `players.length` seats and fills it. The last join rolls the dice.
 * Returns the table id and the receipt of the filling join.
 */
export async function fullTable(
  game: BluffDice,
  players: HardhatEthersSigner[],
  overrides: { gasLimit?: bigint } = {},
): Promise<{ tableId: bigint; fillReceipt: ContractTransactionReceipt }> {
  const tableId = await createTable(game, players[0], players.length);
  let fillReceipt: ContractTransactionReceipt | null = null;
  for (const p of players.slice(1)) {
    fillReceipt = await (await game.connect(p).joinTable(tableId, overrides)).wait();
  }
  if (!fillReceipt) throw new Error("fullTable needs at least 2 players");
  return { tableId, fillReceipt };
}

/** Decrypts `player`'s dice as `reader` through the user-decryption flow (ACL enforced). */
export async function decryptDiceAs(
  game: BluffDice,
  tableId: bigint,
  player: HardhatEthersSigner,
  reader: HardhatEthersSigner,
): Promise<bigint[]> {
  const handles = await game.diceOf(tableId, player.address);
  const gameAddress = await game.getAddress();
  const values: bigint[] = [];
  for (const h of handles) {
    values.push(await fhevm.userDecryptEuint(FhevmType.euint8, h, gameAddress, reader));
  }
  return values;
}

/** Mock ACL contract of the coprocessor the game is configured with. */
export async function aclOf(contractAddress: string) {
  const { ACLAddress } = await fhevm.getCoprocessorConfig(contractAddress);
  return new ethers.Contract(
    ACLAddress,
    [
      "function persistAllowed(bytes32 handle, address account) view returns (bool)",
      "function isAllowed(bytes32 handle, address account) view returns (bool)",
      "function isAllowedForDecryption(bytes32 handle) view returns (bool)",
    ],
    ethers.provider,
  );
}

// -------------------------------------------------------------------------------------------------
// Phase B: Liar and reveal
// -------------------------------------------------------------------------------------------------

/** One hour, `BluffDice.PROOF_TIMEOUT`. */
export const PROOF_TIMEOUT = 3600n;

/**
 * KMS errors. They are thrown by the coprocessor's KMSVerifier, not by our contract, so they are not in our
 * ABI. Names checked against @fhevm/host-contracts KMSVerifier.sol and observed in mock.
 */
export const KMS_ERRORS = {
  interface: new ethers.Interface([
    "error KMSInvalidSigner(address invalidSigner)",
    "error EmptyDecryptionProof()",
    "error DeserializingDecryptionProofFail()",
    "error KMSSignatureThresholdNotReached(uint256 numSignatures)",
    "error KMSZeroSignature()",
  ]),
};

/**
 * Every die of a started table in reveal order (seat 0..n-1, then die 0..4), decrypted with the mock-only
 * debugger, which bypasses the ACL. Tests use it to choose a bid with a known outcome BEFORE anything is public.
 */
export async function decryptAll(game: BluffDice, tableId: bigint): Promise<bigint[]> {
  const t = await game.getTable(tableId);
  const values: bigint[] = [];
  for (let seat = 0; seat < Number(t.maxPlayers); ++seat) {
    for (const h of await game.diceOf(tableId, t.players[seat])) {
      values.push(await fhevm.debugger.decryptEuint(FhevmType.euint8, h));
    }
  }
  return values;
}

/** Number of `values` equal to `face`. */
export function countFace(values: readonly bigint[], face: number): number {
  return values.filter((v) => v === BigInt(face)).length;
}

/**
 * Seat 0 bids (quantity, face) and seat 1 calls "Liar". So the bidder is seat 0 and the caller is seat 1;
 * seats 2 and 3 (if any) are not part of the challenge.
 */
export async function playToLiar(
  game: BluffDice,
  tableId: bigint,
  players: HardhatEthersSigner[],
  quantity: number,
  face: number,
): Promise<ContractTransactionReceipt> {
  await (await game.connect(players[0]).bid(tableId, quantity, face)).wait();
  return (await (await game.connect(players[1]).callLiar(tableId)).wait())!;
}

/** The KMS answer for a table's reveal: `fhevm.publicDecrypt(revealHandles)`, handles in storage order. */
export async function revealProof(game: BluffDice, tableId: bigint) {
  const handles = await game.revealHandles(tableId);
  const r = await fhevm.publicDecrypt([...handles]);
  return { handles: [...handles], ...r };
}

/** Clear values of a `publicDecrypt` result in the order of `handles` (keys are lowercase handles). */
export function clearValuesInOrder(handles: readonly string[], clearValues: Record<string, unknown>): bigint[] {
  return handles.map((h) => {
    const v = clearValues[h.toLowerCase()];
    if (typeof v !== "bigint") throw new Error(`no bigint clear value for ${h}`);
    return v;
  });
}

/** Splits a 0x-prefixed byte string of 32-byte words into words (0x-prefixed). */
export function words(hex: string): string[] {
  const body = hex.slice(2);
  if (body.length % 64 !== 0) throw new Error("not a whole number of words");
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push("0x" + body.slice(i, i + 64));
  return out;
}

/** Joins 32-byte words back into one byte string. */
export function joinWords(ws: readonly string[]): string {
  return "0x" + ws.map((w) => w.slice(2)).join("");
}

/** One 32-byte big-endian word holding `v`. */
export function word(v: bigint | number): string {
  return ethers.zeroPadValue(ethers.toBeHex(v), 32);
}
