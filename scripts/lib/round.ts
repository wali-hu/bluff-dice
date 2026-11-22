/**
 * Shared round runner for Phase D: the same code plays a round in mock (`--network hardhat`, time travel) and on
 * Sepolia (real waits, real relayer, real KMS).
 *
 * Safety rules this file enforces:
 * - Fresh player keys are `new Wallet(hexlify(randomBytes(32)))`, never `Wallet.createRandom()` (an HDNodeWallet
 *   carries a public `mnemonic` field that any error dump would print).
 * - Keys live in process memory only. Every key, user-decryption private key and EIP-712 signature is registered in
 *   a module-private set; `log()` and `writeRunJson()` refuse any string that contains one.
 * - Wallet objects never reach the logger or the JSON writer: only addresses do. The JSON writer takes an
 *   allow-list of keys and rejects anything else.
 *
 * Nothing here imports `hardhat` at module level, so tasks can import it from `hardhat.config.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import type { FhevmTransactionHCUInfo } from "@fhevm/hardhat-plugin";
import { BaseContract, ContractTransactionReceipt, Interface, Signer, Wallet, ethers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import type { BluffChips, BluffDice } from "../../types";

// -------------------------------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------------------------------

/**
 * EIP-7825 per-transaction cap. Since Glamsterdam (Sepolia, 2026-10-06) it bounds EXECUTION gas only; EIP-8037 state
 * gas comes from a reservoir above it and `tx.gas` may reach 2^32 - 1. So it is NOT a bound on gasLimit or gasUsed.
 */
export const TX_GAS_CAP = 16_777_216n;
/** EIP-8037 cost per state byte (fixed constant). */
export const CPSB = 1530n;
/** EIP-8037 state gas of one new storage slot: 64 state bytes x CPSB. */
export const STATE_GAS_PER_NEW_SLOT = 64n * CPSB;
/** Explicit priority tip: the tip Phase A's probe was mined with (ethers' default when the RPC gives none). */
export const PRIORITY_FEE = 1_000_000_000n;
/** `BluffChips.FAUCET_AMOUNT`: 1,000 chips at 6 decimals. */
export const FAUCET_AMOUNT = 1_000_000_000n;
/** Stake of every scripted round: 300 chips (divisible by 1 and 3, so valid for 2 and 4 seats). */
export const ROUND_STAKE = 300_000_000n;
/** Operator approval given right before a join: 10 minutes (SPEC R3). */
export const OPERATOR_TTL = 600;
/** Default per-round cost cap at the live fee (deployer's ETH, funding that is swept back excluded). */
export const DEFAULT_COST_CAP_WEI = ethers.parseEther("0.05");
/** Stop-and-report threshold for any single transaction (owner decision, Phase D: total gasUsed > 30M). */
export const STOP_GAS = 30_000_000n;

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
export const PHASE_NAMES = [
  "None",
  "Joining",
  "AwaitingPaidProof",
  "Bidding",
  "AwaitingReveal",
  "Settled",
  "Cancelled",
];
export const NO_SEAT = 255;
export const DICE_PER_PLAYER = 5;

/**
 * Planned gas per player action, used only to size the first ETH transfer to a fresh wallet (x3.2 estimates from
 * the Phase C table, rounded up). Every send still checks the real `gasLimit x maxFeePerGas` and tops up.
 */
const PLANNED_GAS: Record<string, bigint> = {
  faucet: 1_200_000n,
  setOperator: 150_000n,
  createTable: 2_000_000n,
  joinTable: 2_300_000n,
  leaveTable: 1_300_000n,
  bid: 200_000n,
  callLiar: 2_800_000n,
};

/** Errors a round can hit, from our ABI plus the KMSVerifier, `FHE.checkSignatures`, OZ ECDSA and ERC-7984. */
export const EXTRA_ERRORS = new Interface([
  "error KMSInvalidSigner(address invalidSigner)",
  "error EmptyDecryptionProof()",
  "error DeserializingDecryptionProofFail()",
  "error KMSSignatureThresholdNotReached(uint256 numSignatures)",
  "error KMSZeroSignature()",
  // Sepolia KMSVerifier v0.4.0 only (not in the installed v0.1.0): extraData starts with a version byte.
  "error UnsupportedExtraDataVersion(uint8 version)",
  "error DeserializingExtraDataFail()",
  "error InvalidKMSSignatures()",
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256 length)",
  "error ECDSAInvalidSignatureS(bytes32 s)",
  "error ERC7984UnauthorizedSpender(address holder, address spender)",
  "error ACLNotAllowed(bytes32 handle, address account)",
  "error EnforcedPause()",
]);

// -------------------------------------------------------------------------------------------------
// Secret guard
// -------------------------------------------------------------------------------------------------

const secrets = new Set<string>();

/** Registers a value that must never be printed or written (stored lowercase, without 0x). */
function registerSecret(value: string): void {
  const v = value.toLowerCase().replace(/^0x/, "");
  if (v.length >= 32) secrets.add(v);
}

/** Throws if `text` contains any registered secret (used where data is persisted: run JSON, fixture). */
export function assertNoSecret(text: string): void {
  const lower = text.toLowerCase();
  for (const s of secrets) {
    if (lower.includes(s)) throw new Error("refusing to output a string that contains a private key or signature");
  }
}

/**
 * Replaces every registered secret in `text` with `[redacted]`, case-insensitively. Call it BEFORE any truncation
 * (`slice`): a cut secret would no longer match.
 */
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.replace(new RegExp(`(0x)?${s}`, "gi"), "[redacted]");
  return out;
}

/** An error whose message has every registered secret removed (wrap anything that may carry SDK or wallet text). */
export function redactedError(e: unknown): Error {
  return new Error(redact(String((e as Error)?.message ?? e)));
}

/**
 * Logger: strings only. It redacts and never throws, so a log line can never stop a sweep (fresh-wallet keys live
 * in memory only; an aborted sweep would strand their ETH).
 */
export function log(message: string): void {
  console.log(redact(message));
}

// -------------------------------------------------------------------------------------------------
// Context, actors, transaction rows
// -------------------------------------------------------------------------------------------------

/** A sender. `fresh` wallets are funded by the deployer and swept back at the end. */
export type Actor = {
  readonly name: string;
  readonly address: string;
  readonly signer: Signer;
  readonly fresh: boolean;
};

/** One mined transaction: everything the gas table and the run JSON need. Public data only. */
export type TxRow = {
  label: string;
  fn: string;
  from: string;
  hash: string;
  block: number;
  gasUsed: string;
  gasLimit: string;
  effectiveGasPrice: string;
  hcu: number;
  hcuDepth: number;
};

export type Faults = {
  /** Number of `publicDecrypt` calls that fail with a synthetic `not_ready_for_decryption` first (mock test). */
  notReady: number;
};

export type Ctx = {
  hre: HardhatRuntimeEnvironment;
  game: BluffDice;
  token: BluffChips;
  deployer: Actor;
  isMock: boolean;
  /** Mined transactions of this run (game, token, funding and sweep). */
  rows: TxRow[];
  /** Sum of every fee paid in this run (ETH that leaves the deployer's control for good). */
  feesWei: bigint;
  costCapWei: bigint;
  pollMs: number;
  faults: Faults;
  /** Every fresh wallet created with this context (swept on SIGINT). */
  fresh: Actor[];
  /** The sweep in progress, if any (see `sweep`). */
  sweeping?: Promise<void>;
  /** Highest block of any receipt this context has seen (balance reads wait for it). */
  lastBlock: number;
  /** Next nonce per sender as this process knows it (see `sendWithRetry`). */
  nonces: Map<string, number>;
};

export async function makeCtx(
  hre: HardhatRuntimeEnvironment,
  addresses: { game: string; token: string },
  options: { costCapWei?: bigint; deployer?: Signer } = {},
): Promise<Ctx> {
  const { ethers: hEthers, fhevm } = hre;
  const signer = options.deployer ?? (await hEthers.getSigners())[0];
  const game = (await hEthers.getContractAt("BluffDice", addresses.game, signer)) as unknown as BluffDice;
  const token = (await hEthers.getContractAt("BluffChips", addresses.token, signer)) as unknown as BluffChips;
  return {
    hre,
    game,
    token,
    deployer: { name: "deployer", address: await signer.getAddress(), signer, fresh: false },
    isMock: fhevm.isMock,
    rows: [],
    feesWei: 0n,
    costCapWei: options.costCapWei ?? DEFAULT_COST_CAP_WEI,
    pollMs: fhevm.isMock ? 0 : 4_000,
    faults: { notReady: 0 },
    fresh: [],
    lastBlock: 0,
    nonces: new Map(),
  };
}

/** A new random wallet connected to the network provider. Its key is registered as a secret. */
export function freshActor(ctx: Ctx, name: string): Actor {
  const key = ethers.hexlify(ethers.randomBytes(32));
  registerSecret(key);
  const wallet = new Wallet(key, ctx.hre.ethers.provider);
  const actor = { name, address: wallet.address, signer: wallet, fresh: true };
  ctx.fresh.push(actor);
  return actor;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Receipt wait limit. A dropped or evicted transaction (one pending tx per 7702 account) would otherwise wait forever
 * while fresh-wallet funds sit behind memory-only keys; ethers throws a TIMEOUT error and the caller's finally sweeps.
 */
export const TX_WAIT_MS = 180_000;

/** Relayer call watchdog: a request in flight when the machine suspends can hang forever (R4 on Sepolia). */
export const RELAYER_CALL_TIMEOUT_MS = 120_000;

/** Rejects with a "timed out" error (retryable, see `isNotReady`) if `p` does not settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// -------------------------------------------------------------------------------------------------
// Fees, funding, sending, sweeping
// -------------------------------------------------------------------------------------------------

/** EIP-1559 fees with an explicit 1 gwei tip; `maxFeePerGas = 2 x baseFee + tip`. */
export async function feeOverrides(ctx: Ctx): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await ctx.hre.ethers.provider.getBlock("latest");
  const base = block?.baseFeePerGas ?? 0n;
  return { maxPriorityFeePerGas: PRIORITY_FEE, maxFeePerGas: base * 2n + PRIORITY_FEE };
}

function addFee(ctx: Ctx, receipt: ethers.TransactionReceipt): void {
  ctx.feesWei += receipt.gasUsed * receipt.gasPrice;
  if (ctx.feesWei > ctx.costCapWei) {
    throw new Error(
      `cost cap reached: ${ethers.formatEther(ctx.feesWei)} ETH spent on fees > cap ${ethers.formatEther(ctx.costCapWei)} ETH`,
    );
  }
}

function hcuOf(ctx: Ctx, receipt: ethers.TransactionReceipt): FhevmTransactionHCUInfo | undefined {
  try {
    return ctx.hre.fhevm.computeTransactionHCU(receipt);
  } catch {
    return undefined;
  }
}

/**
 * Balance at a block no older than `minBlock`. Public RPCs are load-balanced and a "latest" read can come from a
 * node that has not seen our last transaction yet (observed in R0: a post-sweep read returned the pre-sweep
 * balance). An explicit block number fails on a lagging node instead of returning a stale value, so we retry.
 */
async function balanceAtLeast(ctx: Ctx, address: string, minBlock: number): Promise<bigint> {
  const provider = ctx.hre.ethers.provider;
  for (let i = 0; ; ++i) {
    try {
      const head = await provider.getBlockNumber();
      if (head >= minBlock) return await provider.getBalance(address, Math.max(head, minBlock));
    } catch (e) {
      if (i >= 30) throw e;
    }
    if (i >= 30) throw new Error(`RPC did not reach block ${minBlock}`);
    await sleep(Math.max(ctx.pollMs, 1_000));
  }
}

function pushRow(
  ctx: Ctx,
  label: string,
  fn: string,
  from: Actor,
  receipt: ethers.TransactionReceipt,
  gasLimit: bigint,
) {
  const hcu = hcuOf(ctx, receipt);
  const row: TxRow = {
    label,
    fn,
    from: from.name,
    hash: receipt.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    gasLimit: gasLimit.toString(),
    effectiveGasPrice: receipt.gasPrice.toString(),
    hcu: hcu?.globalHCU ?? 0,
    hcuDepth: hcu?.maxHCUDepth ?? 0,
  };
  if (receipt.blockNumber > ctx.lastBlock) ctx.lastBlock = receipt.blockNumber;
  ctx.rows.push(row);
  return row;
}

/**
 * Sends one transaction from `from` with an explicit nonce, retrying two RPC artefacts seen on Sepolia:
 * - `in-flight transaction limit reached for delegated accounts`: Sepolia allows one pending transaction per
 *   EIP-7702-delegated account (our deployer), and a load-balanced node can still count our previous, already mined,
 *   transaction as pending. Wait and resend the same nonce.
 * - a stale nonce: a lagging node's "pending" count can be one behind (R2: ethers reused nonce 214). The nonce is
 *   therefore `max(local next nonce, RPC pending count)`, and `nonce too low` re-reads it.
 */
async function sendWithRetry<T extends { nonce: number }>(
  ctx: Ctx,
  label: string,
  from: Actor,
  sendOnce: (nonce: number) => Promise<T>,
): Promise<T> {
  const provider = ctx.hre.ethers.provider;
  const key = from.address.toLowerCase();
  for (let i = 0; ; ++i) {
    const rpc = await provider.getTransactionCount(from.address, "pending");
    const nonce = Math.max(rpc, ctx.nonces.get(key) ?? 0);
    try {
      const tx = await sendOnce(nonce);
      ctx.nonces.set(key, tx.nonce + 1);
      return tx;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const inFlight = /in-flight transaction limit/i.test(msg);
      const tooLow = /nonce too low|nonce has already been used|NONCE_EXPIRED/i.test(msg);
      if ((!inFlight && !tooLow) || i >= 20) throw redactedError(e);
      // A "nonce too low" after this process already sent from `from` can mean our previous attempt with that
      // nonce was mined after all: resending would repeat the action (a mint, a funding transfer). Stop instead.
      if (tooLow && ctx.nonces.has(key)) {
        throw new Error(`${label}: nonce ${nonce} already used although this process tracks it; not resending`);
      }
      // First send from `from` in this process: the RPC's pending count was stale. Skip past it and retry.
      if (tooLow) ctx.nonces.set(key, nonce + 1);
      log(
        `  ${label}: ${inFlight ? "7702 in-flight limit (RPC lag)" : `nonce ${nonce} already used (RPC lag)`}; retry ${i + 1}`,
      );
      await sleep(Math.max(ctx.pollMs, 1_000) + 2_000 * Math.min(i, 3));
    }
  }
}

/** Plain ETH transfer from the deployer (funding). */
async function transferEth(ctx: Ctx, to: Actor, value: bigint, label: string): Promise<void> {
  // Not a fixed 21,000: since Glamsterdam (EIP-8037) the first transfer to a NEW account also pays 120 x 1,530 =
  // 183,600 state gas (Sepolia estimate 248,869). A 21,000 limit runs out of gas and reverts.
  const estimate = await ctx.hre.ethers.provider.estimateGas({ from: ctx.deployer.address, to: to.address, value });
  const gasLimit = (estimate * 12n) / 10n;
  const fee = await feeOverrides(ctx);
  const tx = await sendWithRetry(ctx, label, ctx.deployer, (nonce) =>
    ctx.deployer.signer.sendTransaction({ to: to.address, value, gasLimit, nonce, ...fee }),
  );
  const receipt = await tx.wait(1, TX_WAIT_MS);
  if (!receipt || receipt.status !== 1) throw new Error(`${label}: ETH transfer failed`);
  addFee(ctx, receipt);
  pushRow(ctx, label, "transfer", ctx.deployer, receipt, gasLimit);
}

/** Initial funding: the planned gas of `actions` x maxFeePerGas x 1.5. */
export async function fund(ctx: Ctx, actor: Actor, actions: string[]): Promise<void> {
  const fee = await feeOverrides(ctx);
  let gas = 0n;
  for (const a of actions) {
    const g = PLANNED_GAS[a];
    if (g === undefined) throw new Error(`no planned gas for ${a}`);
    gas += g;
  }
  await transferEth(ctx, actor, (gas * fee.maxFeePerGas * 3n) / 2n, `fund ${actor.name}`);
}

/** Tops a fresh wallet up to `need x 1.5` when its balance is below `need` (the node's reservation check). */
async function ensureFunds(ctx: Ctx, actor: Actor, need: bigint): Promise<void> {
  const balance = await balanceAtLeast(ctx, actor.address, ctx.lastBlock);
  if (balance >= need) return;
  await transferEth(ctx, actor, (need * 3n) / 2n - balance, `top-up ${actor.name}`);
}

/**
 * Sends `contract.fn(...args)` from `from`: estimate, `gasLimit = estimate x 1.2` (no 2^24 clamp: state-heavy
 * transactions need the EIP-8037 reservoir above it), explicit fees, top-up for fresh wallets, wait, record the row.
 * Stops (throws) when estimateGas fails, the transaction reverts, or it uses more than STOP_GAS.
 */
export async function send(
  ctx: Ctx,
  label: string,
  from: Actor,
  contract: BaseContract,
  fn: string,
  args: unknown[],
): Promise<ContractTransactionReceipt> {
  const f = contract.connect(from.signer).getFunction(fn);
  let estimate: bigint;
  try {
    estimate = await f.estimateGas(...args);
  } catch (e) {
    throw new Error(`${label}: estimateGas reverted with ${decodeRevert(ctx, e)}`);
  }
  const gasLimit = (estimate * 12n) / 10n;
  const fee = await feeOverrides(ctx);
  if (from.fresh) await ensureFunds(ctx, from, gasLimit * fee.maxFeePerGas);
  const tx = await sendWithRetry(ctx, label, from, (nonce) => f.send(...args, { gasLimit, nonce, ...fee }));
  const receipt = (await tx.wait(1, TX_WAIT_MS)) as ContractTransactionReceipt | null;
  if (!receipt || receipt.status !== 1) throw new Error(`${label}: transaction failed (${tx.hash})`);
  addFee(ctx, receipt);
  const row = pushRow(ctx, label, fn, from, receipt, gasLimit);
  log(`  ${label.padEnd(34)} gas ${row.gasUsed.padStart(9)} (limit ${gasLimit})  HCU ${row.hcu}  ${row.hash}`);
  if (receipt.gasUsed > STOP_GAS)
    throw new Error(`${label}: ${receipt.gasUsed} gas is above the ${STOP_GAS} stop threshold`);
  return receipt;
}

/**
 * Sends every fresh wallet's ETH back to the deployer with a legacy tx `value = balance - gasLimit x gasPrice`
 * (gasLimit = estimate), which leaves 0 or a few wei of unused-gas dust. Waits for pending transactions first. Never throws (logs instead).
 */
export async function sweep(ctx: Ctx, actors: Actor[]): Promise<void> {
  // One sweep at a time: the SIGINT handler and playRound's finally could otherwise race on the same nonces.
  const previous = ctx.sweeping ?? Promise.resolve();
  const run = previous.then(() => sweepOnce(ctx, actors));
  ctx.sweeping = run;
  return run;
}

async function sweepOnce(ctx: Ctx, actors: Actor[]): Promise<void> {
  const provider = ctx.hre.ethers.provider;
  for (const a of actors) {
    try {
      for (let i = 0; i < 30; ++i) {
        const pending = await provider.getTransactionCount(a.address, "pending");
        const latest = await provider.getTransactionCount(a.address, "latest");
        if (pending === latest) break;
        await sleep(4_000);
      }
      const balance = await balanceAtLeast(ctx, a.address, ctx.lastBlock);
      if (balance === 0n) {
        log(`  sweep ${a.name}: empty (never funded), skipped`);
        continue;
      }
      const block = await provider.getBlock("latest");
      const gasPrice = (block?.baseFeePerGas ?? 0n) * 2n + PRIORITY_FEE;
      // The deployer may carry an EIP-7702 delegation: a transfer to it runs the delegate's code, so its gas is
      // estimated, not assumed to be 21,000. gasLimit = the estimate leaves exactly 0 when gasUsed == estimate
      // (plain EOA); otherwise the unused gas stays behind as dust and is logged.
      const gasLimit = await provider.estimateGas({ from: a.address, to: ctx.deployer.address, value: 1n });
      const value = balance - gasLimit * gasPrice;
      if (value <= 0n) {
        log(`  sweep ${a.name}: ${balance} wei left, below one transfer fee, skipped`);
        continue;
      }
      const tx = await sendWithRetry(ctx, `sweep ${a.name}`, a, (nonce) =>
        a.signer.sendTransaction({ to: ctx.deployer.address, value, gasLimit, gasPrice, nonce, type: 0 }),
      );
      const receipt = await tx.wait(1, TX_WAIT_MS);
      if (!receipt || receipt.status !== 1) throw new Error("sweep tx failed");
      ctx.feesWei += receipt.gasUsed * receipt.gasPrice;
      pushRow(ctx, `sweep ${a.name}`, "transfer", a, receipt, gasLimit);
      const left = await balanceAtLeast(ctx, a.address, receipt.blockNumber);
      log(
        `  sweep ${a.name}: returned ${ethers.formatEther(value)} ETH, ${left} wei left (gas ${receipt.gasUsed} of ${gasLimit})`,
      );
    } catch (e) {
      log(`  sweep ${a.name} FAILED: ${(e as Error).message}`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Inferred EIP-8037 state gas (mock trace)
// -------------------------------------------------------------------------------------------------

type StructLog = { op: string; depth: number; stack?: string[] };

/**
 * Counts the storage slots a MOCK transaction creates (original value 0, final value non-zero), across every
 * contract it touches, from `debug_traceTransaction` struct logs. The Sepolia RPC has no debug API, so the Phase D
 * gas table infers state gas as `newSlots x 97,920` from the same transaction run in mock. Inferred, not measured:
 * the mock host contracts (v0.1.0) are older than Sepolia's, and their storage writes may differ.
 */
export async function countNewSlotsMock(hre: HardhatRuntimeEnvironment, txHash: string): Promise<number> {
  const provider = hre.ethers.provider;
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`no receipt for ${txHash}`);
  const trace = (await hre.network.provider.send("debug_traceTransaction", [
    txHash,
    { disableMemory: true, disableStorage: true },
  ])) as { structLogs: StructLog[] };
  const root = (receipt.to ?? receipt.contractAddress ?? "").toLowerCase();
  const contexts: string[] = [root];
  let pending: string | undefined;
  const finalValues = new Map<string, bigint>();
  let lastDepth = trace.structLogs[0]?.depth ?? 1;
  for (const step of trace.structLogs) {
    if (step.depth > lastDepth) contexts.push(pending ?? "unknown");
    while (step.depth < lastDepth) {
      contexts.pop();
      --lastDepth;
    }
    lastDepth = step.depth;
    const stack = step.stack ?? [];
    const top = (i: number) => BigInt("0x" + stack[stack.length - 1 - i].replace(/^0x/, ""));
    const current = contexts[contexts.length - 1];
    if (step.op === "CALL" || step.op === "STATICCALL") {
      pending = "0x" + top(1).toString(16).padStart(40, "0");
    } else if (step.op === "DELEGATECALL" || step.op === "CALLCODE") {
      pending = current;
    } else if (step.op === "CREATE" || step.op === "CREATE2") {
      pending = "create";
    } else if (step.op === "SSTORE" && current !== "unknown" && current !== "create") {
      finalValues.set(`${current}:${top(0).toString(16)}`, top(1));
    }
  }
  let created = 0;
  for (const [k, v] of finalValues) {
    if (v === 0n) continue;
    const [address, slot] = k.split(":");
    const before = await provider.getStorage(address, "0x" + slot, receipt.blockNumber - 1);
    if (BigInt(before) === 0n) ++created;
  }
  return created;
}

/**
 * Runs a view call at `max(node head, ctx.lastBlock)` instead of "latest". A load-balanced
 * RPC can answer "latest" from a node that lags behind our last transaction (R2: `paidHandles` right after the
 * filling join reverted `PaidCheckNotRequested` on such a node). With an explicit block number a lagging node fails
 * with "header not found" instead of answering stale, and we retry.
 */
export async function readFresh<T>(ctx: Ctx, read: (overrides: { blockTag: number }) => Promise<T>): Promise<T> {
  for (let i = 0; ; ++i) {
    try {
      // Never older than our own last receipt, but as new as the node reports (other processes move tables too).
      const head = await ctx.hre.ethers.provider.getBlockNumber();
      return await read({ blockTag: Math.max(head, ctx.lastBlock) });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (
        !/header not found|unknown block|block not found|missing trie|future block|not yet available/i.test(msg) ||
        i >= 30
      )
        throw e;
      await sleep(Math.max(ctx.pollMs, 1_000));
    }
  }
}

/** Raises `ctx.lastBlock` to a block mined by someone else (an external startGame / finalizeReveal). */
export function sawBlock(ctx: Ctx, block: number): void {
  if (block > ctx.lastBlock) ctx.lastBlock = block;
}

// -------------------------------------------------------------------------------------------------
// Time
// -------------------------------------------------------------------------------------------------

export async function latestTimestamp(ctx: Ctx): Promise<number> {
  const block = await ctx.hre.ethers.provider.getBlock("latest");
  if (!block) throw new Error("no latest block");
  return block.timestamp;
}

/** Waits until the latest block's timestamp is strictly greater than `ts` (mock: time travel). */
export async function waitUntilAfter(ctx: Ctx, ts: bigint | number): Promise<void> {
  const target = Number(ts) + 1;
  if (ctx.isMock) {
    const now = await latestTimestamp(ctx);
    if (now < target) await ctx.hre.network.provider.send("evm_setNextBlockTimestamp", [target]);
    await ctx.hre.network.provider.send("evm_mine", []);
    return;
  }
  let last = -1;
  for (;;) {
    const now = await latestTimestamp(ctx);
    if (now >= target) return;
    const left = target - now;
    if (last < 0 || last - left >= 60) {
      log(`  waiting ${left} s for the chain clock to pass ${Number(ts)}`);
      last = left;
    }
    await sleep(Math.min(ctx.pollMs * 3, Math.max(left * 1000, ctx.pollMs)));
  }
}

/** Polls `getTable(tableId).phase` until it is not `phase` (or until `timeoutMs`). */
export async function waitPhaseLeaves(ctx: Ctx, tableId: bigint, phase: Phase, timeoutMs: number): Promise<Phase> {
  const start = Date.now();
  for (;;) {
    const p = Number((await ctx.game.getTable(tableId)).phase) as Phase;
    if (p !== phase) return p;
    if (Date.now() - start > timeoutMs)
      throw new Error(`table ${tableId} still ${PHASE_NAMES[phase]} after ${timeoutMs} ms`);
    await sleep(Math.max(ctx.pollMs, 1_000));
  }
}

// -------------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------------

/** Finds revert data in an ethers / hardhat error, wherever the provider put it. */
export function revertData(e: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [e];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== "object" || seen.has(x)) continue;
    seen.add(x);
    const o = x as Record<string, unknown>;
    if (typeof o.data === "string" && /^0x[0-9a-fA-F]*$/.test(o.data)) return o.data;
    for (const k of ["error", "info", "cause", "data", "revert"]) if (o[k]) stack.push(o[k]);
  }
  const m = /return data: (0x[0-9a-fA-F]+)/.exec(String((e as Error)?.message ?? ""));
  return m?.[1];
}

/** Decodes a revert against the game, token and extra (KMS / ECDSA / ACL) errors. Unknown selectors stay raw. */
export function decodeRevert(ctx: Ctx | undefined, e: unknown): string {
  const data = revertData(e);
  if (!data) return `no revert data (${redact(String((e as Error)?.message ?? e)).slice(0, 200)})`;
  return decodeRevertData(ctx, data);
}

export function decodeRevertData(ctx: Ctx | undefined, data: string): string {
  if (data === "0x") return "empty revert";
  const interfaces: Interface[] = [EXTRA_ERRORS];
  if (ctx) interfaces.unshift(ctx.game.interface as unknown as Interface, ctx.token.interface as unknown as Interface);
  for (const i of interfaces) {
    try {
      const parsed = i.parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.map((a) => String(a)).join(", ")})`;
    } catch {
      // try the next interface
    }
  }
  return `unknown selector ${data.slice(0, 10)} (raw ${data})`;
}

// -------------------------------------------------------------------------------------------------
// Decryption with retry
// -------------------------------------------------------------------------------------------------

/** True for relayer "not ready" answers and transient network errors (hex stripped so a handle never matches). */
function isNotReady(e: unknown): boolean {
  let s = String((e as Error)?.message ?? e);
  try {
    s += " " + JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    // circular error object: the message is enough
  }
  s = s.replace(/0x[0-9a-fA-F]+/g, "");
  return /not_ready|not ready|readiness|timed? ?out|ECONNRESET|ETIMEDOUT|fetch failed|status:? ?(429|50\d)|MaxRetry/i.test(
    s,
  );
}

export type PublicDecryptResult = {
  clearValues: Record<string, unknown>;
  abiEncodedClearValues: string;
  decryptionProof: string;
  attempts: number;
  ms: number;
};

/** `fhevm.publicDecrypt(handles)`, retrying "not ready" (and transient relayer errors) with backoff. */
export async function publicDecryptRetry(
  ctx: Ctx,
  handles: string[],
  maxMs: number = 300_000,
): Promise<PublicDecryptResult> {
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    ++attempts;
    try {
      if (ctx.faults.notReady > 0) {
        --ctx.faults.notReady;
        throw Object.assign(new Error("Relayer: not_ready_for_decryption (injected by the mock test)"), {
          label: "not_ready_for_decryption",
        });
      }
      const r = await withTimeout(ctx.hre.fhevm.publicDecrypt(handles), RELAYER_CALL_TIMEOUT_MS, "publicDecrypt");
      return {
        clearValues: r.clearValues as Record<string, unknown>,
        abiEncodedClearValues: ethers.hexlify(r.abiEncodedClearValues),
        decryptionProof: ethers.hexlify(r.decryptionProof),
        attempts,
        ms: Date.now() - start,
      };
    } catch (e) {
      // Right after the transaction that made the handles public, the SDK's ACL pre-check can hit a lagging RPC
      // node and refuse (R2 on Sepolia). Retry that refusal for up to 60 s only, so a truly private handle still
      // fails fast.
      const lagging =
        /not allowed for public decryption/i.test(String((e as Error)?.message)) && Date.now() - start < 60_000;
      if ((!isNotReady(e) && !lagging) || Date.now() - start > maxMs) throw redactedError(e);
      log(`  publicDecrypt attempt ${attempts}: not ready yet, retrying`);
      await sleep(Math.min(2_000 * attempts, 10_000) * (ctx.isMock ? 0 : 1));
    }
  }
}

export type UserDecryptResult = { values: bigint[]; attempts: number; ms: number; firstSuccessAt: number };

/**
 * User decryption of `handles` as `actor` (EIP-712 signed by the actor, `durationDays = 1`, contract list =
 * [contractAddress]). One request for all handles. Retries "not ready"; an ACL refusal is thrown at once.
 */
export async function userDecryptAs(
  ctx: Ctx,
  actor: Actor,
  handles: string[],
  contractAddress: string,
  maxMs: number = 300_000,
): Promise<UserDecryptResult> {
  const { fhevm } = ctx.hre;
  const keypair = fhevm.generateKeypair();
  registerSecret(keypair.privateKey);
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;
  const eip = fhevm.createEIP712(keypair.publicKey, [contractAddress], startTimestamp, durationDays);
  const signature = await actor.signer.signTypedData(
    eip.domain,
    { UserDecryptRequestVerification: [...eip.types.UserDecryptRequestVerification] },
    eip.message,
  );
  registerSecret(signature);
  const pairs = handles.map((handle) => ({ handle, contractAddress }));
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    ++attempts;
    try {
      const res = (await withTimeout(
        fhevm.userDecrypt(
          pairs,
          keypair.privateKey,
          keypair.publicKey,
          signature,
          [contractAddress],
          actor.address,
          startTimestamp,
          durationDays,
        ),
        RELAYER_CALL_TIMEOUT_MS,
        "userDecrypt",
      )) as Record<string, unknown>;
      const values = handles.map((h) => {
        const v = res[h.toLowerCase()] ?? res[h];
        if (typeof v !== "bigint") throw new Error(`user decrypt: no bigint for ${h}`);
        return v;
      });
      return { values, attempts, ms: Date.now() - start, firstSuccessAt: Date.now() };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (/not authorized|not allowed/i.test(msg) || Date.now() - start > maxMs) throw redactedError(e);
      log(`  userDecrypt ${actor.name} attempt ${attempts}: ${msg.slice(0, 120)}; retrying`);
      await sleep(ctx.isMock ? 0 : Math.min(3_000 * attempts, 15_000));
    }
  }
}

// -------------------------------------------------------------------------------------------------
// KMS proof parsing and EIP-712 signer recovery
// -------------------------------------------------------------------------------------------------

export type ParsedProof = { numSigners: number; signatures: string[]; extraData: string; wellFormed: boolean };

/** Splits a decryption proof: `uint8 numSigners || numSigners x 65-byte signature || extraData`. */
export function parseProof(proof: string): ParsedProof {
  const bytes = ethers.getBytes(proof);
  const numSigners = bytes.length > 0 ? bytes[0] : 0;
  const end = 1 + 65 * numSigners;
  const signatures: string[] = [];
  for (let i = 0; i < numSigners && 1 + 65 * (i + 1) <= bytes.length; ++i) {
    signatures.push(ethers.hexlify(bytes.slice(1 + 65 * i, 1 + 65 * (i + 1))));
  }
  return {
    numSigners,
    signatures,
    extraData: ethers.hexlify(bytes.slice(Math.min(end, bytes.length))),
    wellFormed: bytes.length >= end,
  };
}

/** Rebuilds a proof from parts. */
export function buildProof(signatures: string[], extraData: string = "0x", numSigners?: number): string {
  return ethers.concat([new Uint8Array([numSigners ?? signatures.length]), ...signatures, extraData]);
}

export type KmsDomain = { name: string; version: string; chainId: bigint; verifyingContract: string };

export const PUBLIC_DECRYPT_TYPES = {
  PublicDecryptVerification: [
    { name: "ctHandles", type: "bytes32[]" },
    { name: "decryptedResult", type: "bytes" },
    { name: "extraData", type: "bytes" },
  ],
};

export const KMS_VERIFIER_ABI = [
  "function verifyDecryptionEIP712KMSSignatures(bytes32[] handlesList, bytes decryptedResult, bytes decryptionProof) returns (bool)",
  "function getKmsSigners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getVersion() view returns (string)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
];

export async function kmsVerifier(ctx: Ctx) {
  const cfg = await ctx.hre.fhevm.getCoprocessorConfig(await ctx.game.getAddress());
  return new ethers.Contract(cfg.KMSVerifierAddress, KMS_VERIFIER_ABI, ctx.hre.ethers.provider);
}

export async function kmsDomain(kms: ethers.Contract, blockTag?: number | string): Promise<KmsDomain> {
  const d = await kms.eip712Domain({ blockTag });
  return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
}

/** EIP-712 digest the KMS signs for a public decryption. */
export function publicDecryptDigest(
  domain: KmsDomain,
  handles: string[],
  cleartexts: string,
  extraData: string,
): string {
  return ethers.TypedDataEncoder.hash(domain, PUBLIC_DECRYPT_TYPES, {
    ctHandles: handles,
    decryptedResult: cleartexts,
    extraData,
  });
}

export type SignerCheck = {
  recovered: string[];
  unique: number;
  threshold: number;
  /** Mirror of the on-chain loop: in order, first unknown signer fails, success when `threshold` unique. */
  verdict: "accepted" | "rejected-unknown-signer" | "below-threshold" | "zero-signatures";
  firstUnknown?: string;
};

/** Off-chain copy of `KMSVerifier._verifySignaturesDigest`. */
export function checkSigners(digest: string, signatures: string[], known: string[], threshold: number): SignerCheck {
  const knownSet = new Set(known.map((a) => a.toLowerCase()));
  const recovered: string[] = [];
  const seen = new Set<string>();
  if (signatures.length === 0) return { recovered, unique: 0, threshold, verdict: "zero-signatures" };
  for (const sig of signatures) {
    let addr: string;
    try {
      addr = ethers.recoverAddress(digest, sig);
    } catch {
      addr = "invalid-signature";
    }
    recovered.push(addr);
    if (!knownSet.has(addr.toLowerCase())) {
      return { recovered, unique: seen.size, threshold, verdict: "rejected-unknown-signer", firstUnknown: addr };
    }
    seen.add(addr.toLowerCase());
    if (seen.size >= threshold) return { recovered, unique: seen.size, threshold, verdict: "accepted" };
  }
  return { recovered, unique: seen.size, threshold, verdict: "below-threshold" };
}

/** 0x-prefixed 32-byte words of a byte string. */
export function words(hex: string): string[] {
  const body = hex.replace(/^0x/, "");
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push("0x" + body.slice(i, i + 64));
  return out;
}

// -------------------------------------------------------------------------------------------------
// Run JSON (allow-listed)
// -------------------------------------------------------------------------------------------------

const RUN_KEYS = new Set([
  "round",
  "network",
  "chainId",
  "game",
  "token",
  "deployer",
  "tableId",
  "players",
  "outcome",
  "status",
  "txs",
  "result",
  "latency",
  "notes",
  "feesWei",
]);
const TX_KEYS = new Set([
  "label",
  "fn",
  "from",
  "hash",
  "block",
  "gasUsed",
  "gasLimit",
  "effectiveGasPrice",
  "hcu",
  "hcuDepth",
]);
const PLAYER_KEYS = new Set(["name", "address", "seat"]);

function checkValue(v: unknown, where: string): void {
  if (v === null || typeof v === "number" || typeof v === "boolean") return;
  if (typeof v === "string") {
    assertNoSecret(v);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => checkValue(x, `${where}[${i}]`));
    return;
  }
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) checkValue(x, `${where}.${k}`);
    return;
  }
  throw new Error(`run JSON: ${where} is not plain data (${typeof v})`);
}

/**
 * Validates a run record against the allow-list (top-level keys, tx row keys, player keys), checks that every value
 * is plain data with no registered secret, and returns the JSON text. Throws on anything else.
 */
export function runJson(record: Record<string, unknown>): string {
  for (const k of Object.keys(record)) if (!RUN_KEYS.has(k)) throw new Error(`run JSON: key "${k}" is not allowed`);
  for (const row of (record.txs as Record<string, unknown>[] | undefined) ?? []) {
    for (const k of Object.keys(row)) if (!TX_KEYS.has(k)) throw new Error(`run JSON: tx key "${k}" is not allowed`);
  }
  for (const p of (record.players as Record<string, unknown>[] | undefined) ?? []) {
    for (const k of Object.keys(p))
      if (!PLAYER_KEYS.has(k)) throw new Error(`run JSON: player key "${k}" is not allowed`);
  }
  checkValue(record, "record");
  const text = JSON.stringify(record, null, 2);
  assertNoSecret(text);
  return text;
}

export function writeRunJson(file: string, record: Record<string, unknown>): void {
  const text = runJson(record);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + "\n");
}
