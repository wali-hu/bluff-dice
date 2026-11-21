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
