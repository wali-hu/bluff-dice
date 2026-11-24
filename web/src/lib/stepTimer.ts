/**
 * Onboarding stopwatch (plan S2: measure N minutes and K signatures for the promise on Home). Records how long
 * each step was on screen, the total from the first step to "seated", and every wallet prompt by kind. Memory
 * only, no console output, no addresses or secrets: read it in the ?debug=1 panel.
 */
export type PromptKind = "connect" | "switchNetwork" | "transaction" | "signature";

export interface StepTimerSnapshot {
  readonly startedAt: number | null;
  readonly seatedAt: number | null;
  readonly current: string | null;
  /** Milliseconds per completed step, in order. */
  readonly steps: readonly { readonly step: string; readonly ms: number }[];
  readonly prompts: Readonly<Record<PromptKind, number>>;
  readonly notes: readonly string[];
}

const EMPTY_PROMPTS: Record<PromptKind, number> = { connect: 0, switchNetwork: 0, transaction: 0, signature: 0 };

export function createStepTimer(now: () => number = () => performance.now()) {
  let state: StepTimerSnapshot = {
    startedAt: null,
    seatedAt: null,
    current: null,
    steps: [],
    prompts: EMPTY_PROMPTS,
    notes: [],
  };
  let currentSince = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  return {
    /** Marks `step` as the one on screen; closes the previous one. Repeating the same step is a no-op. */
    enter(step: string) {
      if (state.seatedAt !== null || state.current === step) return;
      const t = now();
      const steps =
        state.current === null ? state.steps : [...state.steps, { step: state.current, ms: t - currentSince }];
      state = { ...state, startedAt: state.startedAt ?? t, current: step, steps };
      currentSince = t;
      emit();
    },
    /** Stops the clock when the player has a seat. */
    seated() {
      if (state.seatedAt !== null || state.startedAt === null) return;
      const t = now();
      const steps =
        state.current === null ? state.steps : [...state.steps, { step: state.current, ms: t - currentSince }];
      state = { ...state, seatedAt: t, current: null, steps };
      emit();
    },
    prompt(kind: PromptKind) {
      if (state.seatedAt !== null) return;
      state = { ...state, prompts: { ...state.prompts, [kind]: state.prompts[kind] + 1 } };
      emit();
    },
    note(text: string) {
      if (state.notes.includes(text)) return;
      state = { ...state, notes: [...state.notes, text] };
      emit();
    },
    snapshot: (): StepTimerSnapshot => state,
    totalMs: (): number | null =>
      state.startedAt !== null && state.seatedAt !== null ? state.seatedAt - state.startedAt : null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type StepTimer = ReturnType<typeof createStepTimer>;

/** The tab's onboarding timer. */
export const onboardingTimer = createStepTimer();
