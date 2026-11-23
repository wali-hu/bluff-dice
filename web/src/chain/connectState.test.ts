import { UserRejectedRequestError } from "viem";
import { describe, expect, it } from "vitest";

import { CONNECT_MESSAGES, connectView, walletErrorCode } from "./connectState";

describe("connectView", () => {
  it("shows the waiting state while the wallet prompt is open, never an error", () => {
    expect(connectView({ pending: true, error: undefined })).toEqual({
      kind: "waiting",
      message: CONNECT_MESSAGES.waiting,
    });
    // A stale error from an earlier attempt must not show while a new attempt is pending.
    expect(connectView({ pending: true, error: { code: 4001 } }).kind).toBe("waiting");
  });

  it("is idle with no error", () => {
    expect(connectView({ pending: false, error: null })).toEqual({ kind: "idle" });
  });

  it("maps 4001 to a cancelled message, also when wrapped by viem", () => {
    expect(connectView({ pending: false, error: { code: 4001 } }).kind).toBe("rejected");
    const wrapped = new UserRejectedRequestError(new Error("User rejected the request."));
    expect(connectView({ pending: false, error: wrapped })).toEqual({
      kind: "rejected",
      message: CONNECT_MESSAGES.rejected,
    });
  });

  it("maps -32002 (request already pending) to 'open your wallet', not an error", () => {
    const providerError = { code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" };
    const wrapped = Object.assign(new Error("Resource unavailable"), { cause: providerError });
    expect(connectView({ pending: false, error: wrapped })).toEqual({
      kind: "pendingElsewhere",
      message: CONNECT_MESSAGES.pendingElsewhere,
    });
  });

  it("shows a failure only for other errors", () => {
    expect(connectView({ pending: false, error: new Error("boom") }).kind).toBe("failed");
    expect(connectView({ pending: false, error: { code: -32603 } }).kind).toBe("failed");
  });
});

describe("walletErrorCode", () => {
  it("finds the first numeric code along the cause chain", () => {
    expect(walletErrorCode({ cause: { cause: { code: -32002 } } })).toBe(-32002);
    expect(walletErrorCode({ code: "ACTION_REJECTED", cause: { code: 4001 } })).toBe(4001);
    expect(walletErrorCode("not an object")).toBeUndefined();
  });

  it("stops on cycles", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(walletErrorCode(a)).toBeUndefined();
  });
});
