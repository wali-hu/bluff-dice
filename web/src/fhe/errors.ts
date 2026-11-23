/**
 * Errors of the FHE client, classified for the retry policy and the UI. The 0.4.1 UMD does not export its error
 * classes, so classification uses the error name / message (texts read from the installed lib/web.js).
 */
export type FheErrorKind =
  /** SDK ACL pre-check refused: "User ... is not authorized to user decrypt handle ...". RPC lag OR not yours. */
  | "aclRefused"
  /** Public decrypt pre-check: "Handle ... is not allowed for public decryption" (lag right after the tx). */
  | "notPublic"
  /** Relayer 400 `not_ready_for_decryption`. */
  | "notReady"
  /** Our 120 s watchdog fired, or the relayer's own timeout. */
  | "timeout"
  /** Network failure or relayer 5xx. */
  | "network"
  /** No unlocked session, or it expired: sign again. */
  | "locked"
  /** The wallet is not on Sepolia. */
  | "wrongChain"
  /** The signature does not recover to the player's address (e.g. a contract wallet). */
  | "badSignature"
  /** A file of the self-hosted toolkit did not match its pinned sha256, or failed to load. */
  | "asset"
  | "unknown";

export class FheError extends Error {
  readonly kind: FheErrorKind;

  constructor(kind: FheErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FheError";
    this.kind = kind;
  }
}

const RULES: readonly [FheErrorKind, RegExp][] = [
  ["aclRefused", /is not authorized to user decrypt handle/i],
  ["notPublic", /is not allowed for public decryption/i],
  ["notReady", /not_ready_for_decryption/i],
  ["timeout", /RelayerV2TimeoutError|TimeoutError|timed out/i],
  ["network", /RelayerV2FetchError|Failed to fetch|NetworkError|fetch failed|ECONNRESET|status: 5\d\d|HTTP 5\d\d/i],
];

/** Words the player sees for each kind (no SDK internals, no handles). */
export const FHE_ERROR_TEXT: Record<FheErrorKind, string> = {
  aclRefused: "The access list does not allow this decryption (yet).",
  notPublic: "These values are not public yet.",
  notReady: "The KMS is not ready to decrypt these values yet.",
  timeout: "No answer from the relayer within 120 s.",
  network: "The relayer could not be reached.",
  locked: "Sign once to unlock your dice first.",
  wrongChain: "Switch your wallet to Sepolia first.",
  badSignature: "This wallet's signature cannot be used for decryption.",
  asset: "The encryption toolkit failed its integrity check or did not load.",
  unknown: "The decryption failed.",
};

export function classifyFheError(error: unknown): FheError {
  if (error instanceof FheError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const causeMessage =
    error instanceof Error && error.cause instanceof Error ? `${error.cause.name} ${error.cause.message}` : "";
  const text = `${name} ${message} ${causeMessage}`;
  if (name === "AbortError") return new FheError("timeout", FHE_ERROR_TEXT.timeout, { cause: error });
  for (const [kind, re] of RULES) {
    if (re.test(text)) return new FheError(kind, FHE_ERROR_TEXT[kind], { cause: error });
  }
  return new FheError("unknown", FHE_ERROR_TEXT.unknown, { cause: error });
}
