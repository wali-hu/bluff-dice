import type { Address, Hex } from "viem";

import { clearSecrets, registerSecret } from "./safeLog";

/**
 * The user-decrypt session: ML-KEM keypair + EIP-712 signature. Whoever holds both can decrypt this player's
 * dice and chips for the signed duration, so they live ONLY in this module's closure: never React state,
 * localStorage, sessionStorage, IndexedDB, the URL or logs. Dropped on account change, chain change,
 * disconnect and page hide (tab close, navigation away, mobile backgrounding to bfcache).
 */
export interface Session {
  readonly user: Address;
  readonly publicKey: string; // ML-KEM public key, hex without 0x (as the SDK returns it)
  readonly privateKey: string; // ML-KEM private key, hex without 0x
  readonly signature: Hex;
  readonly startTimestamp: number; // unix seconds, as signed
  readonly durationDays: number; // as signed (1)
  readonly contracts: readonly Address[]; // as signed: [BluffDice, BluffChips]
}

let current: Session | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setSession(session: Session): void {
  current = session;
  registerSecret(session.privateKey);
  registerSecret(session.signature);
  emit();
}

/** The live session for `user`, or null when locked, expired or for another account. */
export function getSession(user: Address, nowSeconds = Math.floor(Date.now() / 1000)): Session | null {
  if (!current || current.user.toLowerCase() !== user.toLowerCase()) return null;
  if (nowSeconds >= current.startTimestamp + current.durationDays * 86_400) {
    lock();
    return null;
  }
  return current;
}

/** The live session of whoever unlocked, or null when locked or expired. */
export function currentSession(nowSeconds = Math.floor(Date.now() / 1000)): Session | null {
  return current ? getSession(current.user, nowSeconds) : null;
}

/** Drops the keypair and signature. Idempotent. */
export function lock(): void {
  if (current === null) return;
  current = null;
  clearSecrets();
  emit();
}

/** For UI state only: who is unlocked (never the secrets). */
export function unlockedUser(): Address | null {
  return current?.user ?? null;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let autoLockInstalled = false;

/** Locks on `pagehide` (fires on tab close, reload, navigation away and bfcache). Browser only, once. */
export function installAutoLock(target: Pick<Window, "addEventListener"> = window): void {
  if (autoLockInstalled) return;
  autoLockInstalled = true;
  target.addEventListener("pagehide", () => lock());
}
