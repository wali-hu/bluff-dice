import { classifyFheError, FheError, FHE_ERROR_TEXT, type FheErrorKind } from "./errors";
import { getStatus, setStatus, type FheChannel } from "./status";

/** Every relayer / KMS call is bounded: a hung request (seen in Phase D after a machine suspend) never waits forever. */
export const WATCHDOG_MS = 120_000;

export interface RetryPolicy {
  /** Error kinds that are retried automatically. */
  readonly retryOn: readonly FheErrorKind[];
  /** Delay before attempt n+1 (the last value repeats). Empty = never retry. */
  readonly delaysMs: readonly number[];
  readonly maxAttempts: number;
  /** Stop retrying once this much time has passed since the first attempt. */
  readonly maxElapsedMs: number;
}

/** No automatic retry (init, unlock, the peek demo). Network / timeout errors show Retry to the player. */
export const NO_RETRY: RetryPolicy = { retryOn: [], delaysMs: [], maxAttempts: 1, maxElapsedMs: 0 };

/**
 * Right after a receipt, a lagging RPC makes the SDK's ACL pre-check refuse, or the relayer is not ready yet:
 * retry with backoff 2, 4, 8 s, at most 4 attempts (plan, "Retry policy").
 */
export const LAG_RETRY: RetryPolicy = {
  retryOn: ["aclRefused", "notPublic", "notReady"],
  delaysMs: [2_000, 4_000, 8_000],
  maxAttempts: 4,
  maxElapsedMs: 60_000,
};

/** Own dice right after GameStarted: the same refusals, retried with backoff for up to 60 s. */
export const OWN_DICE_RETRY: RetryPolicy = {
  retryOn: ["aclRefused", "notReady"],
  delaysMs: [2_000, 4_000, 8_000, 8_000],
  maxAttempts: 12,
  maxElapsedMs: 60_000,
};

export interface CallContext {
  /** Aborted by the watchdog (or the caller). Pass it to the SDK so the request really stops. */
  readonly signal: AbortSignal;
  /** Feed the SDK's onProgress here. */
  readonly onProgress: (args: { type: string }) => void;
}

export interface RelayerCallOptions {
  readonly channel: FheChannel;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Injectable clock and sleep for tests. */
  readonly now?: () => number;
}

const PROGRESS_WORDS: Record<string, string> = {
  queued: "Queued at the relayer",
  throttled: "The relayer is busy; waiting for a slot",
  succeeded: "Done",
  timeout: "The relayer timed out",
  abort: "Cancelled",
  failed: "The relayer reported a failure",
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new FheError("timeout", "Cancelled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new FheError("timeout", "Cancelled"));
    });
  });
}

/**
 * Runs `op` with a watchdog. The op gets an AbortSignal (aborted after `timeoutMs`) and is ALSO raced against the
 * timer, so even calls that cannot take a signal (createInstance) are bounded. Failures are classified; kinds in
 * the retry policy are retried with backoff. The channel's status is published for the UI the whole time.
 */
export async function relayerCall<T>(op: (ctx: CallContext) => Promise<T>, options: RelayerCallOptions): Promise<T> {
  const { channel, label, retry = NO_RETRY, timeoutMs = WATCHDOG_MS, signal: outer, now = Date.now } = options;
  const startedAt = now();
  for (let attempt = 1; ; attempt++) {
    const previous = getStatus(channel);
    setStatus(channel, {
      phase: attempt === 1 ? "running" : "retrying",
      label,
      startedAt,
      attempt,
      ...(attempt > 1 && previous.lastError ? { lastError: previous.lastError } : {}),
    });

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", onOuterAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new FheError("timeout", FHE_ERROR_TEXT.timeout));
        reject(new FheError("timeout", FHE_ERROR_TEXT.timeout));
      }, timeoutMs);
    });
    const ctx: CallContext = {
      signal: controller.signal,
      onProgress: ({ type }) => {
        const detail = PROGRESS_WORDS[type];
        if (detail) setStatus(channel, { ...getStatus(channel), detail });
      },
    };

    try {
      const value = await Promise.race([op(ctx), watchdog]);
      setStatus(channel, { phase: "ok", label, startedAt, endedAt: now(), attempt });
      return value;
    } catch (raw) {
      const error = classifyFheError(raw);
      const elapsed = now() - startedAt;
      const delay = retry.delaysMs[Math.min(attempt - 1, retry.delaysMs.length - 1)];
      const canRetry =
        retry.retryOn.includes(error.kind) &&
        delay !== undefined &&
        attempt < retry.maxAttempts &&
        elapsed + delay <= retry.maxElapsedMs &&
        !outer?.aborted;
      if (!canRetry) {
        setStatus(channel, {
          phase: error.kind === "timeout" ? "timedOut" : "failed",
          label,
          startedAt,
          endedAt: now(),
          attempt,
          lastError: error,
        });
        throw error;
      }
      setStatus(channel, { phase: "retrying", label, startedAt, attempt, lastError: error });
      await sleep(delay, outer);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }
}
