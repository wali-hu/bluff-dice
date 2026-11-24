import { walletErrorCode } from "@/chain/connectState";

/**
 * "Play now" (E4.5): one button that runs every remaining onboarding step in order. Pure parts: the batch
 * planner, the EIP-5792 path decision, the batch error mapping and the progress state machine.
 */

// ---- steps ----------------------------------------------------------------------------------------------------

export const PLAY_STEPS = ["connect", "network", "claim", "authorize", "seat", "sign"] as const;
export type PlayStep = (typeof PLAY_STEPS)[number];

export const PLAY_STEP_LABELS: Record<PlayStep, string> = {
  connect: "Connect",
  network: "Sepolia",
  claim: "Claim chips",
  authorize: "Authorize table",
  seat: "Take a seat",
  sign: "Sign to read your dice (free)",
};

// ---- batch planner --------------------------------------------------------------------------------------------

export type SeatTarget =
  | { readonly kind: "join"; readonly tableId: bigint; readonly viaBot: boolean }
  | { readonly kind: "create"; readonly stake: bigint; readonly players: number };

export type PlannedCall =
  | { readonly kind: "faucet" }
  | { readonly kind: "authorize" }
  | { readonly kind: "join"; readonly tableId: bigint }
  | { readonly kind: "create"; readonly stake: bigint; readonly players: number };

export interface PlanInput {
  /** lastFaucet != 0 on this token, or a funded balance handle. */
  readonly claimed: boolean;
  /** The faucet cooldown is running (a claim would revert FaucetCooldown). */
  readonly inCooldown: boolean;
  /** isOperator AND the newest grant has >= 120 s left. */
  readonly operatorValid: boolean;
  readonly target: SeatTarget;
}

export type Plan =
  | { readonly ok: true; readonly calls: readonly PlannedCall[]; readonly steps: readonly PlayStep[] }
  /** Not claimed and the faucet is cooling down: a join would move 0 chips and get the player dropped. */
  | { readonly ok: false; readonly reason: "noChips" };

/**
 * The calls still needed, in order: faucet (only if not claimed and not cooling down), setOperator (only if the
 * grant is not valid for >= 120 s), then the seat (join or create). Only these go into a batch, so a batch never
 * repeats a finished step.
 */
export function planSeat(input: PlanInput): Plan {
  const calls: PlannedCall[] = [];
  const steps: PlayStep[] = [];
  if (!input.claimed) {
    if (input.inCooldown) return { ok: false, reason: "noChips" };
    calls.push({ kind: "faucet" });
    steps.push("claim");
  }
  if (!input.operatorValid) {
    calls.push({ kind: "authorize" });
    steps.push("authorize");
  }
  calls.push(
    input.target.kind === "join"
      ? { kind: "join", tableId: input.target.tableId }
      : { kind: "create", stake: input.target.stake, players: input.target.players },
  );
  steps.push("seat");
  return { ok: true, calls, steps };
}

// ---- EIP-5792 path decision -------------------------------------------------------------------------------------

/** `atomic.status` from wallet_getCapabilities (viem `GetCapabilitiesReturnType`), or why it is unknown. */
export type AtomicCapability = "supported" | "ready" | "unsupported" | "missing" | "error";

export type SeatPath = "single" | "batch" | "batchWithUpgrade" | "sequential";

/**
 * One call: a plain transaction. Several calls: an atomic batch when the wallet says `supported`, or `ready` (it
 * will offer to upgrade the account via EIP-7702 first); anything else (unsupported, no atomic capability,
 * wallet_getCapabilities failed) or the player chose "one by one": the sequential path.
 */
export function decideSeatPath(callCount: number, atomic: AtomicCapability, preferSequential = false): SeatPath {
  if (callCount <= 1) return "single";
  if (preferSequential) return "sequential";
  if (atomic === "supported") return "batch";
  if (atomic === "ready") return "batchWithUpgrade";
  return "sequential";
}

/** Reads `atomic.status` from a capabilities object for one chain, defensively (wallets differ). */
export function atomicStatusOf(capabilities: unknown): AtomicCapability {
  const status = (capabilities as { atomic?: { status?: unknown } } | null | undefined)?.atomic?.status;
  return status === "supported" || status === "ready" || status === "unsupported" ? status : "missing";
}

export const UPGRADE_NOTICE =
  "MetaMask may offer to turn your account into a smart account so these steps fit in one confirmation. That is MetaMask's own feature; you can decline and confirm each step instead.";

// ---- batch error mapping ----------------------------------------------------------------------------------------

export type BatchFailure =
  /** 4001 anywhere in the cause chain: the player said no. Offer "Try again" or "Do it one by one". */
  | { readonly kind: "rejected" }
  /** Any other failure before the batch was submitted (unsupported method, upgrade declined with a wallet
   * specific code, ...): fall back to one by one automatically, real message shown collapsed. */
  | { readonly kind: "fallback"; readonly detail: string }
  /** The batch was submitted but did not succeed (reverted, timed out). */
  | { readonly kind: "failed"; readonly detail: string };

export const USER_REJECTED = 4001;

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 600);
  return String(error).slice(0, 600);
}

export function classifyBatchError(error: unknown, submitted: boolean): BatchFailure {
  if (walletErrorCode(error) === USER_REJECTED || hasUserRejectedName(error)) return { kind: "rejected" };
  return submitted ? { kind: "failed", detail: messageOf(error) } : { kind: "fallback", detail: messageOf(error) };
}

/** viem wraps 4001 as `UserRejectedRequestError` (code 4001); also match by name when the code is lost. */
function hasUserRejectedName(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== null && typeof current === "object"; depth += 1) {
    if ((current as { name?: unknown }).name === "UserRejectedRequestError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---- progress state machine -------------------------------------------------------------------------------------

export type StepStatus = "todo" | "active" | "done" | "failed";

/** What the chain / wallet already say is done (skipped steps count as done). */
export type DoneSet = Readonly<Partial<Record<PlayStep, boolean>>>;

export interface PlayRun {
  readonly running: boolean;
  /** Steps the current wallet prompt covers (a batch covers several). */
  readonly active: readonly PlayStep[];
  /** Steps confirmed during this run (before reads catch up). */
  readonly completed: readonly PlayStep[];
  readonly failed: { readonly step: PlayStep; readonly message: string; readonly detail?: string } | null;
  /** Words for what is happening right now. */
  readonly status: string | null;
  readonly path: SeatPath | null;
  /** Set after "Do it one by one": skip the batch next time. */
  readonly preferSequential: boolean;
  /** The run stopped because the player already sits at another active table (they choose what to do). */
  readonly seatedElsewhere: bigint | null;
}

export const initialPlayRun: PlayRun = {
  running: false,
  active: [],
  completed: [],
  failed: null,
  status: null,
  path: null,
  preferSequential: false,
  seatedElsewhere: null,
};

export type PlayEvent =
  | { readonly type: "start" }
  | { readonly type: "active"; readonly steps: readonly PlayStep[]; readonly status: string }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "path"; readonly path: SeatPath }
  | { readonly type: "done"; readonly steps: readonly PlayStep[] }
  | { readonly type: "failed"; readonly step: PlayStep; readonly message: string; readonly detail?: string }
  | { readonly type: "oneByOne" }
  | { readonly type: "seatedElsewhere"; readonly tableId: bigint }
  | { readonly type: "finished" };

export function playReducer(state: PlayRun, event: PlayEvent): PlayRun {
  switch (event.type) {
    case "start":
      // Resume: keep what was completed, clear the failure. Finished steps are never redone (the runner skips
      // them because the reads say they are done).
      return { ...state, running: true, failed: null, active: [], status: null, seatedElsewhere: null };
    case "active":
      return { ...state, active: event.steps, status: event.status };
    case "status":
      return { ...state, status: event.status };
    case "path":
      return { ...state, path: event.path };
    case "done":
      return {
        ...state,
        active: state.active.filter((s) => !event.steps.includes(s)),
        completed: [...state.completed, ...event.steps.filter((s) => !state.completed.includes(s))],
      };
    case "failed":
      return {
        ...state,
        running: false,
        active: [],
        status: null,
        failed: { step: event.step, message: event.message, ...(event.detail ? { detail: event.detail } : {}) },
      };
    case "oneByOne":
      return { ...state, preferSequential: true };
    case "seatedElsewhere":
      return { ...state, running: false, active: [], status: null, seatedElsewhere: event.tableId };
    case "finished":
      return { ...state, running: false, active: [], status: null };
  }
}

// ---- seats at other tables ---------------------------------------------------------------------------------------

/**
 * Where the player already sits, relative to the table they asked for. BluffDice only refuses a second seat at the
 * SAME table (`AlreadySeated`); one address may sit at several tables. So a seat at another active table is never
 * taken as "seated here" (no silent redirect): the player is told and chooses.
 *
 * @param activeSeats ids of not-finished tables the player sits at, newest first
 * @param requested the table from ?table=N, if any
 */
export type SeatSituation =
  | { readonly kind: "free" }
  | { readonly kind: "atTarget"; readonly tableId: bigint }
  | { readonly kind: "elsewhere"; readonly tableId: bigint };

export function seatSituation(activeSeats: readonly bigint[], requested: bigint | undefined): SeatSituation {
  if (requested !== undefined && activeSeats.includes(requested)) return { kind: "atTarget", tableId: requested };
  const other = activeSeats.find((id) => id !== requested);
  return other === undefined ? { kind: "free" } : { kind: "elsewhere", tableId: other };
}

/** The progress bar: chain-done or run-completed = done; the failed step; the active ones; the rest todo. */
export function progressOf(done: DoneSet, run: PlayRun): Record<PlayStep, StepStatus> {
  const out = {} as Record<PlayStep, StepStatus>;
  for (const step of PLAY_STEPS) {
    if (done[step] || run.completed.includes(step)) out[step] = "done";
    else if (run.failed?.step === step) out[step] = "failed";
    else if (run.active.includes(step)) out[step] = "active";
    else out[step] = "todo";
  }
  return out;
}

/** The first step that is not done yet (where "Try again" resumes), or null when everything is done. */
export function resumeStep(done: DoneSet, run: PlayRun): PlayStep | null {
  const progress = progressOf(done, run);
  return PLAY_STEPS.find((s) => progress[s] !== "done") ?? null;
}

// ---- connect + switch (3b) --------------------------------------------------------------------------------------

export type ConnectFlow =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly message: string }
  | { readonly kind: "switching"; readonly message: string }
  | { readonly kind: "ready" }
  | { readonly kind: "rejected"; readonly message: string };

export const CONNECT_AND_SWITCH = "Approve the connection, then the switch to Sepolia";

/** One action connects AND puts the wallet on Sepolia (wagmi `connect({ chainId })`, then switchChain if needed). */
export function connectFlow(input: {
  connecting: boolean;
  switching: boolean;
  connected: boolean;
  onSepolia: boolean;
  error: unknown;
}): ConnectFlow {
  if (input.connecting) return { kind: "pending", message: CONNECT_AND_SWITCH };
  if (input.switching) return { kind: "switching", message: "Approve the switch to Sepolia in your wallet" };
  if (input.connected && input.onSepolia) return { kind: "ready" };
  if (input.error !== null && input.error !== undefined && walletErrorCode(input.error) === USER_REJECTED) {
    return { kind: "rejected", message: "Cancelled in the wallet. Press Play now to try again." };
  }
  return { kind: "idle" };
}
