import fs from "node:fs";
import path from "node:path";

import type { LogDescription } from "ethers";
import { task, types } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

import { Fixture, readFixture } from "../scripts/lib/fixture";
import { finalizeTable } from "../scripts/lib/play";
import {
  Ctx,
  PHASE_NAMES,
  Phase,
  assertNoSecret,
  buildProof,
  checkSigners,
  decodeRevert,
  kmsDomain,
  kmsVerifier,
  log,
  makeCtx,
  parseProof,
  publicDecryptDigest,
  publicDecryptRetry,
  words,
} from "../scripts/lib/round";

/**
 * Phase D probes of the real Sepolia stack, run on table R1 after its filling join and BEFORE its startGame.
 * Everything is a free eth_call except the final real `startGame`.
 *
 *   npx hardhat --network sepolia task:probe-reveal --table <R1> --other <R0>
 *
 * (0) versions and KMS parameters; (a) one real public decrypt of the paid flags, dissected; (b) the revert table:
 * tampered inputs straight against the KMSVerifier proxy; (c) ACL idempotence, the handle formula, duplicate
 * handles at the relayer; then the real startGame. Results go to docs/runs/phase-d/probes.json (local).
 */

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** Sepolia HCULimit proxy (docs contract_addresses, confirmed on-chain in Phase A). */
const SEPOLIA_HCU_LIMIT = "0xa10998783c8CF88D886Bc30307e631D6686F0A22";

/** FHEVMExecutor `Operators` enum indexes (installed host-contracts v0.1.0, FHEVMExecutor.sol L87-L116). */
const OPERATOR_INDEX: Record<string, number> = {
  FheAdd: 0,
  FheSub: 1,
  FheMul: 2,
  FheDiv: 3,
  FheRem: 4,
  FheBitAnd: 5,
  FheBitOr: 6,
  FheBitXor: 7,
  FheShl: 8,
  FheShr: 9,
  FheRotl: 10,
  FheRotr: 11,
  FheEq: 12,
  FheNe: 13,
  FheGe: 14,
  FheGt: 15,
  FheLe: 16,
  FheLt: 17,
  FheMin: 18,
  FheMax: 19,
};
const TRIVIAL_ENCRYPT_INDEX = 24;

type Row = { case: string; expected: string; got: string; matches: boolean };

/** `_appendMetadataToPrehandle` of the installed executor: byte 21 = 0xff, chain id, type, version 0. */
function withMetadata(prehandle: string, type: number, chainId: bigint, version: number): string {
  let v = BigInt(prehandle) & ~((1n << 88n) - 1n);
  v |= 0xffn << 80n;
  v |= BigInt.asUintN(64, chainId) << 16n;
  v |= BigInt(type) << 8n;
  v |= BigInt(version);
  return "0x" + v.toString(16).padStart(64, "0");
}

async function versions(ctx: Ctx): Promise<Record<string, unknown>> {
  const { ethers } = ctx.hre;
  const cfg = await ctx.hre.fhevm.getCoprocessorConfig(await ctx.game.getAddress());
  const named: Record<string, string> = {
    ACL: cfg.ACLAddress,
    FHEVMExecutor: cfg.CoprocessorAddress,
    KMSVerifier: cfg.KMSVerifierAddress,
    HCULimit: SEPOLIA_HCU_LIMIT,
  };
  const out: Record<string, unknown> = {};
  for (const [name, address] of Object.entries(named)) {
    const c = new ethers.Contract(address, ["function getVersion() view returns (string)"], ethers.provider);
    let version: string;
    try {
      version = await c.getVersion();
    } catch (e) {
      version = `getVersion reverted: ${decodeRevert(ctx, e)}`;
    }
    const slot = await ethers.provider.getStorage(address, EIP1967_IMPL_SLOT);
    out[name] = { address, version, implementation: ethers.getAddress("0x" + slot.slice(26)) };
    log(`  ${name.padEnd(14)} ${address}  ${version}  impl ${ethers.getAddress("0x" + slot.slice(26))}`);
  }
  const kms = await kmsVerifier(ctx);
  const domain = await kmsDomain(kms);
  const signers = [...(await kms.getKmsSigners())].map(String);
  const threshold = Number(await kms.getThreshold());
  out.kms = { domain: { ...domain, chainId: domain.chainId.toString() }, signers, threshold };
  log(
    `  KMS domain ${domain.name} v${domain.version} chainId ${domain.chainId} verifyingContract ${domain.verifyingContract}`,
  );
  log(`  KMS signers ${signers.length}, threshold ${threshold}`);
  return out;
}

/**
 * Recomputes the handles of a faucet receipt with the installed v0.1.0 formula and with Sepolia's v0.6.0 formula,
 * and logs MATCH / DIFFERENT for each.
 */
async function handleFormula(ctx: Ctx, f: Fixture, tableId: bigint): Promise<Record<string, string>> {
  const { ethers, fhevm } = ctx.hre;
  const cfg = await fhevm.getCoprocessorConfig(await ctx.game.getAddress());
  // Handle formula, recomputed from a faucet receipt of this round.
  const entry = f.tables.find((x) => x.tableId === Number(tableId));
  // Any faucet of this deployment works (this table's own txs are recorded only when its runner ends).
  const faucetHash = [entry, ...f.tables].flatMap((x) => x?.txs ?? []).find((x) => x.label === "faucet")?.hash;
  const formula: Record<string, string> = {};
  if (faucetHash) {
    const receipt = await ethers.provider.getTransactionReceipt(faucetHash);
    const ev = new ethers.Interface([
      "event TrivialEncrypt(address indexed caller, uint256 pt, uint8 toType, bytes32 result)",
      ...Object.keys(OPERATOR_INDEX).map(
        (k) => `event ${k}(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)`,
      ),
    ]);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    // Sepolia FHEVMExecutor v0.6.0 (verified source of impl 0xdCFA...2A03): the prehandle is
    // keccak256(abi.encodePacked(bytes8 "FHE_comp", op, ..., acl, chainid, blockhash(block.number - 1), block.timestamp)).
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const parent = await ethers.provider.getBlock(receipt!.blockNumber - 1);
    const SEP = ethers.encodeBytes32String("FHE_comp").slice(0, 18);
    for (const l of receipt?.logs ?? []) {
      if (l.address.toLowerCase() !== cfg.CoprocessorAddress.toLowerCase()) continue;
      let parsed: LogDescription | null = null;
      try {
        parsed = ev.parseLog(l);
      } catch {
        continue;
      }
      if (!parsed) continue;
      const actual = String(parsed.args.result);
      const version = Number(BigInt(actual) & 0xffn);
      const type = Number((BigInt(actual) >> 8n) & 0xffn);
      let pre: string;
      if (parsed.name === "TrivialEncrypt") {
        if (formula.trivialEncrypt) continue;
        pre = ethers.keccak256(
          ethers.solidityPacked(
            ["uint8", "uint256", "uint8", "address", "uint256"],
            [TRIVIAL_ENCRYPT_INDEX, parsed.args.pt, parsed.args.toType, cfg.ACLAddress, chainId],
          ),
        );
        const mine = withMetadata(pre, Number(parsed.args.toType), chainId, version);
        formula.trivialEncrypt = `${mine === actual ? "MATCH" : "DIFFERENT"}: asEuint64(${parsed.args.pt}) -> ${actual} (recomputed ${mine}, handle version byte ${version})`;
        const v6 = withMetadata(
          ethers.keccak256(
            ethers.solidityPacked(
              ["bytes8", "uint8", "uint256", "uint8", "address", "uint256", "bytes32", "uint256"],
              [
                SEP,
                TRIVIAL_ENCRYPT_INDEX,
                parsed.args.pt,
                parsed.args.toType,
                cfg.ACLAddress,
                chainId,
                parent!.hash,
                block!.timestamp,
              ],
            ),
          ),
          Number(parsed.args.toType),
          chainId,
          version,
        );
        formula.trivialEncryptV6 = `${v6 === actual ? "MATCH" : "DIFFERENT"} with the v0.6.0 formula (+ "FHE_comp", blockhash(n-1), timestamp): recomputed ${v6}`;
      } else {
        if (formula.binaryOp) continue;
        pre = ethers.keccak256(
          ethers.solidityPacked(
            ["uint8", "bytes32", "bytes32", "bytes1", "address", "uint256"],
            [
              OPERATOR_INDEX[parsed.name],
              parsed.args.lhs,
              parsed.args.rhs,
              parsed.args.scalarByte,
              cfg.ACLAddress,
              chainId,
            ],
          ),
        );
        const mine = withMetadata(pre, type, chainId, version);
        formula.binaryOp = `${mine === actual ? "MATCH" : "DIFFERENT"}: ${parsed.name}(scalar ${parsed.args.scalarByte}) -> ${actual} (recomputed ${mine})`;
        const v6 = withMetadata(
          ethers.keccak256(
            ethers.solidityPacked(
              ["bytes8", "uint8", "bytes32", "bytes32", "bytes1", "address", "uint256", "bytes32", "uint256"],
              [
                SEP,
                OPERATOR_INDEX[parsed.name],
                parsed.args.lhs,
                parsed.args.rhs,
                parsed.args.scalarByte,
                cfg.ACLAddress,
                chainId,
                parent!.hash,
                block!.timestamp,
              ],
            ),
          ),
          type,
          chainId,
          version,
        );
        formula.binaryOpV6 = `${v6 === actual ? "MATCH" : "DIFFERENT"} with the v0.6.0 formula: recomputed ${v6}`;
      }
    }
  } else {
    formula.note = "no faucet tx of this table in the fixture";
  }
  for (const [k, v] of Object.entries(formula)) log(`  handle formula ${k}: ${v}`);
  return formula;
}

task("task:probe-reveal", "Phase D probes on R1 (after its fill, before its startGame), then the real startGame")
  .addParam("table", "R1 table id (AwaitingPaidProof)", undefined, types.int)
  .addParam("other", "R0 table id (another table's paid handles)", undefined, types.int)
  .addFlag("noStart", "do not send the real startGame at the end")
  .addFlag("formulaOnly", "only re-run the handle-formula probe (works on any table phase)")
  .setAction(async function (args: TaskArguments, hre) {
    const { ethers, fhevm } = hre;
    await fhevm.initializeCLIApi();
    const f = readFixture();
    if (!f) throw new Error("no fixture");
    const ctx = await makeCtx(hre, { game: f.game, token: f.token });
    const tableId = BigInt(args.table);
    const otherId = BigInt(args.other);
    const out: Record<string, unknown> = { table: args.table, other: args.other };
    if (args.formulaOnly) {
      const formula = await handleFormula(ctx, f, tableId);
      const file = path.join(__dirname, "..", "docs", "runs", "phase-d", "formula.json");
      const text = JSON.stringify({ table: args.table, formula }, null, 2);
      assertNoSecret(text);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text + "\n");
      log(`formula results: ${file}`);
      return;
    }
    const t = await ctx.game.getTable(tableId);
    if (Number(t.phase) !== Phase.AwaitingPaidProof)
      throw new Error(`table ${tableId} is ${PHASE_NAMES[Number(t.phase)]}, not AwaitingPaidProof`);

    log("\n(0) versions and KMS parameters");
    out.versions = await versions(ctx);
    const kms = await kmsVerifier(ctx);
    const domain = await kmsDomain(kms);
    const known = [...(await kms.getKmsSigners())].map(String);
    const threshold = Number(await kms.getThreshold());

    log("\n(a) real public decrypt of the paid flags");
    const handles = [...(await ctx.game.paidHandles(tableId))].map(String);
    const r = await publicDecryptRetry(ctx, handles);
    const p = parseProof(r.decryptionProof);
    const n = p.numSigners;
    const digest = publicDecryptDigest(domain, handles, r.abiEncodedClearValues, p.extraData);
    const sc = checkSigners(digest, p.signatures, known, threshold);
    const allRecovered = p.signatures.map((s) => ethers.recoverAddress(digest, s));
    const a = {
      latencyMs: r.ms,
      attempts: r.attempts,
      clearValues: Object.fromEntries(Object.entries(r.clearValues).map(([k, v]) => [k, `${typeof v}:${String(v)}`])),
      abiEncodedClearValues: words(r.abiEncodedClearValues),
      proofLength: ethers.dataLength(r.decryptionProof),
      numSigners: n,
      expectedLength: 1 + 65 * n,
      extraData: p.extraData,
      signatures: p.signatures,
      recovered: allRecovered,
      allRecoveredAreKmsSigners: allRecovered.every((x) => known.map((k) => k.toLowerCase()).includes(x.toLowerCase())),
      offChainVerdict: sc.verdict,
    };
    out.a = a;
    log(`  latency ${a.latencyMs} ms (${a.attempts} attempt(s)); clearValues ${JSON.stringify(a.clearValues)}`);
    log(`  abiEncodedClearValues words: ${a.abiEncodedClearValues.join(" ")}`);
    log(`  proof ${a.proofLength} bytes = 1 + 65 x ${n} + extraData ${p.extraData} (expected ${a.expectedLength})`);
    log(`  recovered signers (all in getKmsSigners: ${a.allRecoveredAreKmsSigners}): ${allRecovered.join(", ")}`);
    if (a.proofLength !== a.expectedLength)
      throw new Error("STOP: proof length is not 1 + 65 x numSigners (extraData not empty)");
    if (sc.verdict !== "accepted") throw new Error(`STOP: off-chain recovery verdict ${sc.verdict}`);

    // Game path, while R1 is still AwaitingPaidProof.
    const gameRows: Row[] = [];
    try {
      await ctx.game.startGame.staticCall(tableId, r.abiEncodedClearValues, r.decryptionProof);
      gameRows.push({ case: "game: valid proof (staticCall)", expected: "accepted", got: "accepted", matches: true });
    } catch (e) {
      gameRows.push({
        case: "game: valid proof (staticCall)",
        expected: "accepted",
        got: decodeRevert(ctx, e),
        matches: false,
      });
    }
    const dup = buildProof(Array(threshold).fill(p.signatures[0]));
    try {
      await ctx.game.startGame.staticCall(tableId, r.abiEncodedClearValues, dup);
      gameRows.push({
        case: `game: ${threshold} copies of one signature`,
        expected: "InvalidKMSSignatures()",
        got: "accepted",
        matches: false,
      });
    } catch (e) {
      const got = decodeRevert(ctx, e);
      gameRows.push({
        case: `game: ${threshold} copies of one signature`,
        expected: "InvalidKMSSignatures()",
        got,
        matches: got === "InvalidKMSSignatures()",
      });
    }

    log("\n(b) revert table: eth_call straight to the KMSVerifier proxy");
    const call = async (h: string[], clear: string, proof: string): Promise<string> => {
      try {
        const ok = await kms.verifyDecryptionEIP712KMSSignatures.staticCall(h, clear, proof);
        return `returned ${String(ok)}`;
      } catch (e) {
        return decodeRevert(ctx, e);
      }
    };
    const flipByte = (hex: string, index: number): string => {
      const b = ethers.getBytes(hex);
      b[index] ^= 0x01;
      return ethers.hexlify(b);
    };
    const ws = words(r.abiEncodedClearValues);
    const tampered = ethers.concat([ethers.zeroPadValue(ethers.toBeHex(BigInt(ws[0]) ^ 1n), 32), ...ws.slice(1)]);
    const sigFlipped = (k: number) => buildProof(p.signatures.map((s, i) => (i === k ? flipByte(s, 40) : s)));
    const otherHandles = [...(await ctx.game.paidHandles(otherId))].map(String);
    const r2 = await publicDecryptRetry(ctx, handles);

    const cases: [string, string, () => Promise<string>][] = [
      ["valid proof (control)", "returned true", () => call(handles, r.abiEncodedClearValues, r.decryptionProof)],
      ["tampered value (word 0 flipped)", "KMSInvalidSigner", () => call(handles, tampered, r.decryptionProof)],
      [
        "extraData added (+0x00)",
        "KMSInvalidSigner",
        () => call(handles, r.abiEncodedClearValues, ethers.concat([r.decryptionProof, "0x00"])),
      ],
      [
        "byte changed in signature 1 (k <= t)",
        "KMSInvalidSigner|ECDSA",
        () => call(handles, r.abiEncodedClearValues, sigFlipped(0)),
      ],
      [
        `byte changed in signature ${n} (k > t)`,
        n > threshold ? "returned true" : "KMSInvalidSigner|ECDSA",
        () => call(handles, r.abiEncodedClearValues, sigFlipped(n - 1)),
      ],
      ["empty proof", "EmptyDecryptionProof()", () => call(handles, r.abiEncodedClearValues, "0x")],
      [
        `duplicated signature (${threshold} copies)`,
        "returned false",
        () => call(handles, r.abiEncodedClearValues, dup),
      ],
      [
        `too few signatures (${threshold - 1})`,
        "KMSSignatureThresholdNotReached",
        () => call(handles, r.abiEncodedClearValues, buildProof(p.signatures.slice(0, threshold - 1))),
      ],
      [
        `numSigners = n-1 (${n - 1}), all ${n} present`,
        "UnsupportedExtraDataVersion",
        () => call(handles, r.abiEncodedClearValues, buildProof(p.signatures, "0x", n - 1)),
      ],
      [
        `numSigners = n+1 (${n + 1})`,
        "DeserializingDecryptionProofFail()",
        () => call(handles, r.abiEncodedClearValues, buildProof(p.signatures, "0x", n + 1)),
      ],
      [
        "truncated (last byte dropped)",
        "DeserializingDecryptionProofFail()",
        () => call(handles, r.abiEncodedClearValues, ethers.dataSlice(r.decryptionProof, 0, a.proofLength - 1)),
      ],
      [
        "truncated (inside signature 3)",
        "DeserializingDecryptionProofFail()",
        () => call(handles, r.abiEncodedClearValues, ethers.dataSlice(r.decryptionProof, 0, 1 + 65 * 2 + 10)),
      ],
      ["numSigners = 0 (0x00)", "KMSZeroSignature()", () => call(handles, r.abiEncodedClearValues, "0x00")],
      [
        "signatures permuted (reversed)",
        "returned true",
        () => call(handles, r.abiEncodedClearValues, buildProof([...p.signatures].reverse())),
      ],
      [
        "other table's handles (R0) with R1's proof",
        "KMSInvalidSigner",
        () => call(otherHandles, r.abiEncodedClearValues, r.decryptionProof),
      ],
      [
        "second publicDecrypt of the same handles (its own proof)",
        "returned true",
        () => call(handles, r2.abiEncodedClearValues, r2.decryptionProof),
      ],
    ];
    const rows: Row[] = [...gameRows];
    for (const [name, expected, run] of cases) {
      const got = await run();
      const matches = expected.split("|").some((x) => got.startsWith(x));
      rows.push({ case: name, expected, got, matches });
    }
    const proofsDiffer = r2.decryptionProof !== r.decryptionProof;
    const sameSet = new Set(
      parseProof(r2.decryptionProof).signatures.map((s) => ethers.recoverAddress(digest, s).toLowerCase()),
    );
    out.nonUnique = {
      proofsDiffer,
      clearValuesEqual: r2.abiEncodedClearValues === r.abiEncodedClearValues,
      signerSetsEqual:
        allRecovered.every((x) => sameSet.has(x.toLowerCase())) &&
        sameSet.size === new Set(allRecovered.map((x) => x.toLowerCase())).size,
    };
    out.b = rows;
    for (const row of rows)
      log(`  [${row.matches ? "as expected" : "UNEXPECTED"}] ${row.case}: ${row.got}  (expected ${row.expected})`);
    log(
      `  two publicDecrypt calls of the same handles: proofs ${proofsDiffer ? "DIFFER" : "identical"}; ${JSON.stringify(out.nonUnique)}`,
    );

    log("\n(c) extra probes");
    const cfg = await fhevm.getCoprocessorConfig(await ctx.game.getAddress());
    const acl = new ethers.Contract(
      cfg.ACLAddress,
      [
        "function allowForDecryption(bytes32[] handlesList)",
        "function isAllowedForDecryption(bytes32) view returns (bool)",
      ],
      ethers.provider,
    );
    let idempotence: string;
    try {
      await acl.allowForDecryption.staticCall([handles[0]], { from: await ctx.game.getAddress() });
      idempotence = "no revert: re-publishing an already public flag works";
    } catch (e) {
      idempotence = `reverted ${decodeRevert(ctx, e)}`;
    }
    log(`  ACL idempotence (eth_call allowForDecryption([paid0]) from the game): ${idempotence}`);

    const formula = await handleFormula(ctx, f, tableId);

    let duplicates: Record<string, unknown>;
    try {
      const d = await publicDecryptRetry(ctx, [handles[0], handles[0]], 120_000);
      const dp = parseProof(d.decryptionProof);
      duplicates = {
        words: words(d.abiEncodedClearValues).length,
        clearValueKeys: Object.keys(d.clearValues).length,
        numSigners: dp.numSigners,
        kmsVerifier: await call([handles[0], handles[0]], d.abiEncodedClearValues, d.decryptionProof),
      };
    } catch (e) {
      duplicates = { error: (e as Error).message.slice(0, 300) };
    }
    log(`  relayer publicDecrypt([paid0, paid0]): ${JSON.stringify(duplicates)}`);
    out.c = { idempotence, formula, duplicates };

    const unexpected = rows.filter((x) => !x.matches);
    const file = path.join(__dirname, "..", "docs", "runs", "phase-d", "probes.json");
    const text = JSON.stringify(out, null, 2);
    assertNoSecret(text);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text + "\n");
    log(`\nprobe results: ${file}`);
    if (unexpected.length > 0)
      throw new Error(`STOP: ${unexpected.length} revert-table row(s) came out unexpected; startGame NOT sent`);

    if (args.noStart) return;
    log("\nreal startGame");
    const receipt = await finalizeTable(ctx, tableId);
    if (!receipt) throw new Error("startGame not sent");
    const verified = receipt.logs.some((l) => {
      try {
        return ctx.game.interface.parseLog(l)?.name === "PublicDecryptionVerified";
      } catch {
        return false;
      }
    });
    log(
      `  PublicDecryptionVerified emitted: ${verified}; table now ${PHASE_NAMES[Number((await ctx.game.getTable(tableId)).phase)]}`,
    );
  });
