import type { FheError } from "./errors";

/** What each kind of FHE call is doing right now, for <RelayerStatus/>. Observable, React-free. */
export type FheChannel = "init" | "unlock" | "userDecrypt" | "publicDecrypt";

export type CallPhase = "idle" | "running" | "retrying" | "ok" | "failed" | "timedOut";

export interface CallStatus {
  readonly phase: CallPhase;
  /** Words for the current step, e.g. "Decrypting your chips". */
  readonly label: string;
  /** Relayer progress words (queued / throttled), when the SDK reports them. */
  readonly detail?: string;
  /** Date.now() when the call (first attempt) started. */
  readonly startedAt?: number;
  /** Date.now() when it ended (ok / failed / timedOut). */
  readonly endedAt?: number;
  readonly attempt: number;
  readonly lastError?: FheError;
}

const IDLE: CallStatus = { phase: "idle", label: "", attempt: 0 };

const statuses = new Map<FheChannel, CallStatus>();
const listeners = new Set<() => void>();

export function getStatus(channel: FheChannel): CallStatus {
  return statuses.get(channel) ?? IDLE;
}

export function setStatus(channel: FheChannel, status: CallStatus): void {
  statuses.set(channel, status);
  for (const listener of listeners) listener();
}

export function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function resetStatusesForTests(): void {
  statuses.clear();
}
