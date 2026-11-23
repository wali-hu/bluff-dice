// Prints the files a `vercel deploy` from the repo root would upload, and exits 1 if anything outside web/ or any
// env / key / local-only file would be included. Uses the same `ignore` library as the Vercel CLI, with
// .vercelignore plus the CLI's always-ignored folders. Run before every deploy: `npm run deploy:check`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ignore from "ignore";

const root = process.cwd();
const rules = readFileSync(join(root, ".vercelignore"), "utf8");
const ig = ignore().add(rules).add([".git", ".vercel", "node_modules"]);

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = relative(root, join(dir, entry.name));
    const asDir = entry.isDirectory() ? `${path}/` : path;
    if (ig.ignores(asDir)) continue;
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else files.push(path);
  }
}
walk(root);
files.sort();

const forbidden = [
  [/^(?!web\/)/, "outside web/"],
  [/(^|\/)\.env/, "env file"],
  [/(^|\/)(CLAUDE|SETUP)\.md$/i, "local-only file"],
  [/(^|\/)\.claude\//, "local-only folder"],
  [/(^|\/)docs\//, "local-only folder"],
  [/\.(pem|key)$/i, "key file"],
  [/(^|\/)(\.next|node_modules|\.vercel)\//, "build or tooling output"],
];
const problems = files.flatMap((f) => forbidden.filter(([re]) => re.test(f)).map(([, why]) => `${f}  (${why})`));

for (const f of files) console.log(f);
console.log(`\n${files.length} files would be uploaded.`);
if (problems.length > 0) {
  console.error(`\nABORT: ${problems.length} forbidden file(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("OK: only web/ files, no env or local-only files.");
