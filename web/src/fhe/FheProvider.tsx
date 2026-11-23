"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConnection } from "wagmi";
import { getPublicClient } from "wagmi/actions";

import { wagmiConfig } from "@/chain/wagmi";
import { SEPOLIA_RPC_URL } from "@/config/env";

import type { FheClient } from "./client";
import { createSdkClient } from "./sdkClient";
import { installAutoLock, subscribeSession, unlockedUser } from "./session";
import { getStatus, subscribeStatus, type CallStatus, type FheChannel } from "./status";
import { getInitTiming, subscribeInitTiming, type InitTiming } from "./timing";

const FheContext = createContext<FheClient | null>(null);

/** Start loading the toolkit when the browser is idle after hydration (never blocks the first paint). */
function whenIdle(work: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(work, { timeout: 2_000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(work, 500);
  return () => window.clearTimeout(id);
}

export function FheProvider({ children }: { children: React.ReactNode }) {
  // Created once per tab. Touches no browser API until init() runs (safe during prerender).
  const [client] = useState<FheClient>(() =>
    createSdkClient({ rpcUrl: SEPOLIA_RPC_URL, publicClient: getPublicClient(wagmiConfig) }),
  );

  useEffect(() => {
    installAutoLock(window);
    return whenIdle(() => {
      // Failures are published on the "init" channel (RelayerStatus shows them with Retry).
      client.init().catch(() => undefined);
    });
  }, [client]);

  // Drop the decryption session on account change, chain change and disconnect.
  const { address, chainId, status } = useConnection();
  const connectionKey = `${status}|${address ?? ""}|${chainId ?? ""}`;
  const previousKey = useRef<string | null>(null);
  useEffect(() => {
    if (previousKey.current !== null && previousKey.current !== connectionKey) client.lock();
    previousKey.current = connectionKey;
  }, [client, connectionKey]);

  return <FheContext.Provider value={client}>{children}</FheContext.Provider>;
}

export function useFheClient(): FheClient {
  const client = useContext(FheContext);
  if (!client) throw new Error("useFheClient must be used inside <FheProvider>");
  return client;
}

const SERVER_STATUS: CallStatus = { phase: "idle", label: "", attempt: 0 };

export function useFheStatus(channel: FheChannel): CallStatus {
  return useSyncExternalStore(
    subscribeStatus,
    () => getStatus(channel),
    () => SERVER_STATUS,
  );
}

const EMPTY_TIMING: InitTiming = {};

export function useInitTiming(): InitTiming {
  return useSyncExternalStore(subscribeInitTiming, getInitTiming, () => EMPTY_TIMING);
}

/** Address that currently holds a decryption session (null when locked). Never exposes the secrets. */
export function useUnlockedUser() {
  return useSyncExternalStore(subscribeSession, unlockedUser, () => null);
}
