import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ARTIFACTS, KMS_VERIFIER_ARTIFACT, KMS_VERIFIER_ERRORS } from "../../scripts/abiSources.mts";

import * as abis from "./abi";

const webDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const artifactsPresent = Object.values(ARTIFACTS).every((path) => existsSync(resolve(webDir, path)));

function artifactAbi(path: string): unknown {
  return JSON.parse(readFileSync(resolve(webDir, path), "utf8")).abi;
}

describe.skipIf(!artifactsPresent)("ABI sync (root artifacts present)", () => {
  it.each(Object.entries(ARTIFACTS))("%s equals the Hardhat artifact (run `npm run sync-abi` if not)", (name, path) => {
    expect(abis[name as keyof typeof ARTIFACTS]).toEqual(artifactAbi(path));
  });

  it.skipIf(!existsSync(resolve(webDir, KMS_VERIFIER_ARTIFACT)))(
    "KMSVerifier errors equal the installed artifact",
    () => {
      const kms = artifactAbi(KMS_VERIFIER_ARTIFACT) as { type: string; name?: string }[];
      for (const name of KMS_VERIFIER_ERRORS) {
        const expected = kms.find((item) => item.type === "error" && item.name === name);
        expect(abis.kmsVerifierErrorsAbi.find((item) => item.name === name)).toEqual(expected);
      }
    },
  );
});

describe.runIf(!artifactsPresent)("ABI sync (no root artifacts)", () => {
  it("is skipped: compile the contracts at the repo root to compare abi.ts with the artifacts", () => {
    console.warn("ABI sync check skipped: ../artifacts not found (expected on Vercel or in a web-only checkout).");
  });
});
