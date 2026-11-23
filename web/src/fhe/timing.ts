/** Init timing (ms per phase), also recorded as performance measures ("fhe:<phase>") for DevTools / headless. */
export type InitPhase = "script" | "wasm" | "keys" | "createInstance" | "total";

export type InitTiming = Partial<Record<InitPhase, number>>;

let timing: InitTiming = {};
const listeners = new Set<() => void>();

export function markInit(phase: InitPhase, ms: number): void {
  timing = { ...timing, [phase]: ms };
  try {
    performance.measure(`fhe:${phase}`, { start: performance.now() - ms, duration: ms });
  } catch {
    // performance.measure with options is not available everywhere; the numbers are still kept here.
  }
  for (const listener of listeners) listener();
}

export function getInitTiming(): InitTiming {
  return timing;
}

export function subscribeInitTiming(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
