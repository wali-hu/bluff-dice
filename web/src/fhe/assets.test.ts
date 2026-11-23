import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FHE_ASSETS, FHE_SDK_VERSION } from "./assets";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe("self-hosted FHE assets", () => {
  it.each(Object.entries(FHE_ASSETS))("%s matches its pinned size and sha256", (_name, asset) => {
    const bytes = readFileSync(join(publicDir, asset.url));
    expect(bytes.length).toBe(asset.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
  });

  it("the UMD integrity attribute matches the file (sha384)", () => {
    const bytes = readFileSync(join(publicDir, FHE_ASSETS.umd.url));
    expect(FHE_ASSETS.umd.integrity).toBe(`sha384-${createHash("sha384").update(bytes).digest("base64")}`);
  });

  it("every binary in public/fhe is in the manifest (no unpinned files)", () => {
    const pinned = new Set(Object.values(FHE_ASSETS).map((a) => a.url));
    const files = listFiles(join(publicDir, "fhe"))
      .filter((f) => !f.endsWith(".bin.json"))
      .map(
        (f) =>
          `/${f
            .slice(publicDir.length + 1)
            .split("\\")
            .join("/")}`,
      );
    expect(files.sort()).toEqual([...pinned].sort());
  });

  it("serves the SDK version that is installed", () => {
    expect(FHE_SDK_VERSION).toBe("0.4.1");
    expect(FHE_ASSETS.umd.url).toContain(`relayer-sdk-${FHE_SDK_VERSION}/`);
    expect(FHE_ASSETS.umd.url.endsWith(".js")).toBe(true); // .cjs would be blocked under nosniff
  });
});
