import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FheError } from "./errors";
import { LAG_RETRY, NO_RETRY, relayerCall, WATCHDOG_MS } from "./relayerCall";
import { getStatus, resetStatusesForTests } from "./status";

beforeEach(() => {
  vi.useFakeTimers();
  resetStatusesForTests();
});
afterEach(() => vi.useRealTimers());

describe("relayerCall", () => {
  it("times out after 120 s, aborts the signal and reports timedOut", async () => {
    let seen: AbortSignal | undefined;
    const call = relayerCall(
      ({ signal }) => {
        seen = signal;
        return new Promise(() => undefined); // never settles (the Phase D hang)
      },
      { channel: "publicDecrypt", label: "Decrypting" },
    );
    const expectation = expect(call).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expectation;
    expect(seen?.aborted).toBe(true);
    expect(getStatus("publicDecrypt").phase).toBe("timedOut");
  });

  it("an outer abort stops the call", async () => {
    const outer = new AbortController();
    const call = relayerCall(
      ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))),
      { channel: "userDecrypt", label: "Decrypting", signal: outer.signal },
    );
    outer.abort();
    await expect(call).rejects.toMatchObject({ kind: "timeout" });
  });

  it("retries lag refusals with backoff 2 s, 4 s, then succeeds", async () => {
    let attempts = 0;
    const call = relayerCall(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("User address 0x1 is not authorized to user decrypt handle 0x2!");
        return "clear";
      },
      { channel: "userDecrypt", label: "Decrypting", retry: LAG_RETRY },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    expect(getStatus("userDecrypt").phase).toBe("retrying");
    expect(getStatus("userDecrypt").lastError?.kind).toBe("aclRefused");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(call).resolves.toBe("clear");
    expect(attempts).toBe(3);
    expect(getStatus("userDecrypt")).toMatchObject({ phase: "ok", attempt: 3 });
  });

  it("gives up after max attempts", async () => {
    let attempts = 0;
    const call = relayerCall(
      async () => {
        attempts++;
        throw new Error("Relayer 400 not_ready_for_decryption");
      },
      { channel: "publicDecrypt", label: "Decrypting", retry: LAG_RETRY },
    );
    const expectation = expect(call).rejects.toMatchObject({ kind: "notReady" });
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
    await expectation;
    expect(attempts).toBe(LAG_RETRY.maxAttempts);
    expect(getStatus("publicDecrypt").phase).toBe("failed");
  });

  it("does not retry network errors (the player gets Retry)", async () => {
    let attempts = 0;
    const call = relayerCall(
      async () => {
        attempts++;
        throw new TypeError("Failed to fetch");
      },
      { channel: "publicDecrypt", label: "Decrypting", retry: LAG_RETRY },
    );
    await expect(call).rejects.toMatchObject({ kind: "network" });
    expect(attempts).toBe(1);
  });

  it("forwards SDK progress as words", async () => {
    const call = relayerCall(
      async ({ onProgress }) => {
        onProgress({ type: "queued" });
        expect(getStatus("userDecrypt").detail).toBe("Queued at the relayer");
        return 1;
      },
      { channel: "userDecrypt", label: "Decrypting", retry: NO_RETRY },
    );
    await expect(call).resolves.toBe(1);
  });

  it("passes FheError kinds through unchanged", async () => {
    await expect(
      relayerCall(
        async () => {
          throw new FheError("locked", "Sign first");
        },
        { channel: "userDecrypt", label: "x" },
      ),
    ).rejects.toMatchObject({ kind: "locked", message: "Sign first" });
  });
});
