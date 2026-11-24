// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("debug flag", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.resetModules();
  });
  afterEach(() => window.sessionStorage.clear());

  it("is off by default", async () => {
    const { getDebugFlag } = await import("./useSearchParam");
    expect(getDebugFlag()).toBe(false);
  });

  it("survives a new page load in the same tab (sessionStorage), and stores only the flag", async () => {
    const first = await import("./useSearchParam");
    first.setDebugFlag(true);
    expect(window.sessionStorage.getItem(first.DEBUG_STORAGE_KEY)).toBe("1");
    expect(window.sessionStorage.length).toBe(1);

    vi.resetModules(); // a full page load: module memory is gone, sessionStorage is not
    const second = await import("./useSearchParam");
    expect(second.getDebugFlag()).toBe(true);
  });

  it("?debug=0 turns it off for the tab", async () => {
    const { setDebugFlag, getDebugFlag, DEBUG_STORAGE_KEY } = await import("./useSearchParam");
    setDebugFlag(true);
    setDebugFlag(false);
    expect(getDebugFlag()).toBe(false);
    expect(window.sessionStorage.getItem(DEBUG_STORAGE_KEY)).toBeNull();
  });

  it("falls back to memory when storage throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { setDebugFlag, getDebugFlag } = await import("./useSearchParam");
    setDebugFlag(true);
    expect(getDebugFlag()).toBe(true);
    spy.mockRestore();
  });
});
