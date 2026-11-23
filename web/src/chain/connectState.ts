/**
 * What the connect button shows while a wallet connection is in flight or has just failed.
 *
 * Wallet errors reach us wrapped (viem/wagmi put the provider's EIP-1193 error in `cause`), so the code is
 * searched along the whole `cause` chain. Only a real rejection (4001) or a real failure is shown as an error;
 * "request already pending" (-32002) means a wallet prompt is already open, which is not a failure.
 */

/** EIP-1193 `userRejectedRequest`. */
export const USER_REJECTED = 4001;
/** JSON-RPC `resource unavailable`; MetaMask uses it for "request of type ... already pending". */
export const REQUEST_ALREADY_PENDING = -32002;

export type ConnectView =
  | { kind: "idle" }
  | { kind: "waiting"; message: string }
  | { kind: "pendingElsewhere"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "failed"; message: string };

export const CONNECT_MESSAGES = {
  waiting: "Approve the connection in your wallet",
  pendingElsewhere: "Open your wallet to finish connecting",
  rejected: "Connection cancelled.",
  failed: "Could not connect. Try again.",
} as const;

/** First numeric `code` found on the error or any error in its `cause` chain (max 10 levels). */
export function walletErrorCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== null && typeof current === "object"; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "number") return code;
    current = cause;
  }
  return undefined;
}

export function connectView(input: { pending: boolean; error: unknown }): ConnectView {
  if (input.pending) return { kind: "waiting", message: CONNECT_MESSAGES.waiting };
  if (input.error === null || input.error === undefined) return { kind: "idle" };
  const code = walletErrorCode(input.error);
  if (code === REQUEST_ALREADY_PENDING) return { kind: "pendingElsewhere", message: CONNECT_MESSAGES.pendingElsewhere };
  if (code === USER_REJECTED) return { kind: "rejected", message: CONNECT_MESSAGES.rejected };
  return { kind: "failed", message: CONNECT_MESSAGES.failed };
}
