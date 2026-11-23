/**
 * Self-hosts the FHE client: copies the relayer SDK 0.4.1 browser bundle (UMD, WASM, worker) from node_modules
 * into public/fhe/, downloads the Sepolia FHE public key and the 2048-bit CRS ONCE (public data), and writes the
 * manifest src/fhe/assets.ts with the byte size, sha256 and source of every file. The app verifies every file
 * against the manifest at runtime before using it.
 *
 * Run from web/:   npm run sync-fhe-assets            (keeps existing key/CRS files)
 *                  npm run sync-fhe-assets -- --keys  (re-downloads key and CRS)
 *
 * Notes
 * - The UMD is copied byte for byte and only RENAMED from .umd.cjs to .umd.js: with
 *   `X-Content-Type-Options: nosniff` a browser refuses to run a script served as `application/node` (.cjs).
 *   Its base URL needs no rewrite: it resolves `/tfhe_bg.wasm` itself only when initSDK gets no tfheParams, and we
 *   always pass the verified WASM bytes. The worker (`workerHelpers.js`) is only used for the multi-threaded WASM
 *   pool, which needs cross-origin isolation (COOP/COEP) that this app does not enable; it is shipped for
 *   completeness and pinned like the rest.
 * - Asset paths carry the SDK version and a content hash, so they can be cached as immutable.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_VERSION = "0.4.1";
const RELAYER_URL = "https://relayer.testnet.zama.org";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkDir = join(webDir, "node_modules/@zama-fhe/relayer-sdk");
const publicDir = join(webDir, "public");
const sdkOut = join(publicDir, "fhe", `relayer-sdk-${SDK_VERSION}`);
const keysOut = join(publicDir, "fhe", "sepolia");
const manifestFile = join(webDir, "src/fhe/assets.ts");
const refreshKeys = process.argv.includes("--keys");

interface Entry {
  url: string;
  bytes: number;
  sha256: string;
  source: string;
  id?: string;
  integrity?: string;
}

function hash(bytes: Buffer, algorithm: "sha256" | "sha384", encoding: "hex" | "base64"): string {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function entryFor(file: string, source: string, extra: Partial<Entry> = {}): Entry {
  const bytes = readFileSync(file);
  return {
    url: `/${file
      .slice(publicDir.length + 1)
      .split("\\")
      .join("/")}`,
    bytes: bytes.length,
    sha256: hash(bytes, "sha256", "hex"),
    source,
    ...extra,
  };
}

// ---- 1. SDK bundle ------------------------------------------------------------------------------------------
const installed = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version;
if (installed !== SDK_VERSION) throw new Error(`Expected @zama-fhe/relayer-sdk ${SDK_VERSION}, found ${installed}`);

rmSync(sdkOut, { recursive: true, force: true });
mkdirSync(sdkOut, { recursive: true });
const copies = [
  ["umd", "bundle/relayer-sdk-js.umd.cjs", "relayer-sdk-js.umd.js"],
  ["tfheWasm", "bundle/tfhe_bg.wasm", "tfhe_bg.wasm"],
  ["kmsWasm", "bundle/kms_lib_bg.wasm", "kms_lib_bg.wasm"],
  ["worker", "bundle/workerHelpers.js", "workerHelpers.js"],
] as const;

const manifest: Record<string, Entry> = {};
for (const [key, from, to] of copies) {
  const bytes = readFileSync(join(sdkDir, from));
  writeFileSync(join(sdkOut, to), bytes);
  manifest[key] = entryFor(join(sdkOut, to), `npm @zama-fhe/relayer-sdk@${SDK_VERSION} ${from}`);
}
// Subresource Integrity for the <script> tag (same origin; a second, browser-enforced check).
manifest.umd = {
  ...(manifest.umd as Entry),
  integrity: `sha384-${hash(readFileSync(join(sdkOut, "relayer-sdk-js.umd.js")), "sha384", "base64")}`,
};

// ---- 2. Sepolia public key + CRS (public data, downloaded once) ---------------------------------------------
interface KeyUrlResponse {
  response: {
    fheKeyInfo: { fhePublicKey: { dataId: string; urls: string[] } }[];
    crs: Record<string, { dataId: string; urls: string[] }>;
  };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const previous = existsSync(keysOut) ? readdirSync(keysOut) : [];
const haveKeys = previous.some((f) => f.startsWith("public-key.")) && previous.some((f) => f.startsWith("crs-2048."));

if (refreshKeys || !haveKeys) {
  const keyUrl = `${RELAYER_URL}/v2/keyurl`;
  const info = ((await (await fetch(keyUrl)).json()) as KeyUrlResponse).response;
  const pk = info.fheKeyInfo[0]?.fhePublicKey;
  const crs = info.crs["2048"];
  if (!pk?.urls[0] || !crs?.urls[0]) throw new Error(`Unexpected ${keyUrl} response`);
  rmSync(keysOut, { recursive: true, force: true });
  mkdirSync(keysOut, { recursive: true });
  for (const [name, item] of [
    ["public-key", pk],
    ["crs-2048", crs],
  ] as const) {
    const bytes = await download(item.urls[0] as string);
    const file = join(keysOut, `${name}.${hash(bytes, "sha256", "hex").slice(0, 16)}.bin`);
    writeFileSync(file, bytes);
    writeFileSync(`${file}.json`, JSON.stringify({ id: item.dataId, source: item.urls[0], keyUrl }, null, 2) + "\n");
  }
}

for (const [key, prefix] of [
  ["publicKey", "public-key."],
  ["crs2048", "crs-2048."],
] as const) {
  const file = readdirSync(keysOut).find((f) => f.startsWith(prefix) && f.endsWith(".bin"));
  if (!file) throw new Error(`Missing ${prefix}*.bin in ${keysOut}`);
  const meta = JSON.parse(readFileSync(join(keysOut, `${file}.json`), "utf8")) as { id: string; source: string };
  manifest[key] = entryFor(join(keysOut, file), meta.source, { id: meta.id });
}

// ---- 3. Manifest ------------------------------------------------------------------------------------------
const body = `// GENERATED by scripts/sync-fhe-assets.mts. Do not edit by hand.
/**
 * Every file of the self-hosted FHE client, pinned by sha256. The browser verifies each file against this
 * manifest before use; a unit test checks the files in public/ against it.
 */
export const FHE_SDK_VERSION = "${SDK_VERSION}";

export const FHE_ASSETS = ${JSON.stringify(manifest, null, 2)} as const;

export type FheAsset = (typeof FHE_ASSETS)[keyof typeof FHE_ASSETS];
`;
writeFileSync(manifestFile, body);
execFileSync("npx", ["prettier", "--write", manifestFile], { cwd: resolve(webDir, ".."), stdio: "inherit" });
console.log(`Wrote ${manifestFile}`);
for (const [key, entry] of Object.entries(manifest)) {
  console.log(
    `${key.padEnd(10)} ${String(entry.bytes).padStart(9)} B  sha256 ${entry.sha256.slice(0, 16)}  ${entry.url}`,
  );
}
