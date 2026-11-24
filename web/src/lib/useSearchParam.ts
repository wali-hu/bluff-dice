"use client";

import { useEffect, useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

/**
 * A query parameter, read on the client only (null during prerender), so static pages need no Suspense boundary
 * for useSearchParams.
 */
export function useSearchParam(name: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  );
}

/**
 * `?debug=1` once in this tab keeps the debug panel on across routes, full page loads and reloads, until the tab
 * closes or `?debug=0` is opened. The only thing stored is the flag "1" in sessionStorage (no secrets, no data);
 * storage errors (private mode, blocked storage) fall back to memory.
 */
export const DEBUG_STORAGE_KEY = "bluff.debug";

let debugLatched: boolean | undefined;
const debugListeners = new Set<() => void>();

function readStoredDebug(): boolean {
  try {
    return window.sessionStorage.getItem(DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDebugFlag(on: boolean): void {
  try {
    if (on) window.sessionStorage.setItem(DEBUG_STORAGE_KEY, "1");
    else window.sessionStorage.removeItem(DEBUG_STORAGE_KEY);
  } catch {
    // Storage unavailable: the flag lives in memory for this page load only.
  }
  if (debugLatched === on) return;
  debugLatched = on;
  debugListeners.forEach((listener) => listener());
}

export function getDebugFlag(): boolean {
  debugLatched ??= readStoredDebug();
  return debugLatched;
}

function subscribeDebug(listener: () => void): () => void {
  debugListeners.add(listener);
  return () => debugListeners.delete(listener);
}

export function useDebugFlag(): boolean {
  const value = useSearchParam("debug");
  useEffect(() => {
    if (value === "1") setDebugFlag(true);
    else if (value === "0") setDebugFlag(false);
  }, [value]);
  return useSyncExternalStore(subscribeDebug, getDebugFlag, () => false);
}
