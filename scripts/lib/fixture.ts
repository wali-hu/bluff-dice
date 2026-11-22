/**
 * `test/sepolia/recorded-rounds.json`: the committed, public-only record of the Phase D Sepolia deployment and its
 * rounds (chain id, addresses, table ids, tx hashes, blocks). It lets anyone with a clone re-verify every round
 * with `npm run test:sepolia` or `scripts/verify-round.ts`, without a key and without spending ETH.
 */
import fs from "node:fs";
import path from "node:path";

import { assertNoSecret } from "./round";

export const FIXTURE_FILE = path.join(__dirname, "..", "..", "test", "sepolia", "recorded-rounds.json");

export type RecordedTable = {
  /** Round id from the Phase D plan, e.g. "R1". */
  id: string;
  tableId: number;
  players: number;
  outcome: string;
  /** Block of `createTable`: lower bound for the log search. */
  fromBlock: number;
  /** Transaction label -> hash, in the order they were sent. */
  txs: { label: string; hash: string }[];
};

export type Fixture = {
  chainId: number;
  game: string;
  token: string;
  bidTimeout: number;
  deployBlock: number;
  deployTxs: { label: string; hash: string }[];
  tables: RecordedTable[];
};

export function readFixture(): Fixture | undefined {
  if (!fs.existsSync(FIXTURE_FILE)) return undefined;
  return JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8")) as Fixture;
}

/** Writes the fixture after checking its shape and that it holds no registered secret. */
export function writeFixture(f: Fixture): void {
  const allowed = new Set(["chainId", "game", "token", "bidTimeout", "deployBlock", "deployTxs", "tables"]);
  for (const k of Object.keys(f)) if (!allowed.has(k)) throw new Error(`fixture: key "${k}" is not allowed`);
  const text = JSON.stringify(f, null, 2) + "\n";
  assertNoSecret(text);
  fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
  fs.writeFileSync(FIXTURE_FILE, text);
}

/** Adds or replaces the table with the same round id. */
export function recordTable(t: RecordedTable): void {
  const f = readFixture();
  if (!f) throw new Error("no fixture yet: record the deployment first");
  f.tables = f.tables.filter((x) => x.id !== t.id);
  f.tables.push(t);
  writeFixture(f);
}
