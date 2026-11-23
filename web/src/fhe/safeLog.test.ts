import { afterEach, describe, expect, it, vi } from "vitest";

import { assertNoSecret, clearSecrets, containsSecret, registerSecret, safeLog, SecretLeakError } from "./safeLog";

const SECRET = `0x${"ab".repeat(65)}`;

afterEach(() => {
  clearSecrets();
  vi.restoreAllMocks();
});

describe("secret guard", () => {
  it("detects a registered secret with or without 0x, any case", () => {
    registerSecret(SECRET);
    expect(containsSecret(`sig=${SECRET}`)).toBe(true);
    expect(containsSecret(`sig=${SECRET.slice(2).toUpperCase()}`)).toBe(true);
    expect(containsSecret("nothing here")).toBe(false);
  });

  it("assertNoSecret throws", () => {
    registerSecret(SECRET);
    expect(() => assertNoSecret(`payload ${SECRET}`)).toThrow(SecretLeakError);
    expect(assertNoSecret("fine")).toBe("fine");
  });

  it("safeLog drops lines with secrets, including inside objects", () => {
    registerSecret(SECRET);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    safeLog("info", "request", { signature: SECRET.slice(2) });
    expect(info).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).not.toContain(SECRET.slice(2));
    safeLog("info", "ok", { n: 1n });
    expect(info).toHaveBeenCalledWith('[fhe] ok {"n":"1n"}');
  });

  it("ignores short strings (no false positives on tiny values)", () => {
    registerSecret("0x1234");
    expect(containsSecret("0x1234")).toBe(false);
  });
});
