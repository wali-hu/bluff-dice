"use client";

import { useSyncExternalStore } from "react";
import { useBalance, useConnection, useConnectors } from "wagmi";

import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";

import { gateStatus, type GateStatus } from "./gates";

const noop = () => () => {};

/** True after hydration; false during prerender and the first client render (keeps both identical). */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/** Whether the browser exposes an injected wallet (window.ethereum). False on the server. */
export function useHasInjectedWallet(): boolean {
  return useSyncExternalStore(
    noop,
    () => typeof (window as { ethereum?: unknown }).ethereum !== "undefined",
    () => false,
  );
}

export function useWalletGate(): { status: GateStatus; balanceWei: bigint | undefined } {
  const mounted = useMounted();
  const injected = useHasInjectedWallet();
  const connectors = useConnectors();
  // EIP-6963 wallets appear as their own connectors; "injected" is the generic window.ethereum fallback.
  const hasWallet = injected || connectors.some((connector) => connector.id !== "injected");
  const { status, chainId, address } = useConnection();
  const balance = useBalance({
    address,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: Boolean(address) && chainId === SEPOLIA_CHAIN_ID, refetchInterval: 15_000 },
  });
  const balanceWei = balance.data?.value;
  return {
    status: gateStatus({ mounted, hasWallet, connection: status, chainId, balanceWei }),
    balanceWei,
  };
}
