"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { BLUFF_CHIPS_ADDRESS, SEPOLIA_CHAIN_ID } from "@/contracts/addresses";
import { useFheClient, useUnlockedUser } from "@/fhe/FheProvider";
import { ZERO_HANDLE } from "@/fhe/sdkClient";
import { OPERATOR_LOG_BLOCKS } from "@/lib/onboarding";

import { findOperatorExpiry } from "./logs";
import { getBalanceHandle, getIsOperator, getLastFaucet, withLagRetry } from "./reads";
import { allowsBackToBackWrites, isEip7702Delegated } from "./txQueue";

export interface PlayerChainReads {
  readonly lastFaucet: bigint;
  readonly balanceHandle: Hex;
  readonly isOperator: boolean;
  readonly operatorUntil: bigint | undefined;
  readonly delegated7702: boolean;
  readonly backToBack: boolean;
  readonly readAtBlock: bigint;
}

export const PLAYER_READS_KEY = "player-reads";

/** Everything the onboarding steps depend on, read before a step is shown (refreshed every 15 s and after txs). */
export function usePlayerReads() {
  const client = usePublicClient();
  const { address, chainId, status } = useConnection();
  const enabled = status === "connected" && address !== undefined && chainId === SEPOLIA_CHAIN_ID && Boolean(client);
  return useQuery({
    queryKey: [PLAYER_READS_KEY, address],
    enabled,
    refetchInterval: 15_000,
    queryFn: async (): Promise<PlayerChainReads> => {
      const user = address as Address;
      const [lastFaucet, balanceHandle, isOperator, head, code] = await Promise.all([
        getLastFaucet(client!, user),
        getBalanceHandle(client!, user),
        getIsOperator(client!, user),
        withLagRetry(() => client!.getBlockNumber({ cacheTime: 0 })),
        withLagRetry(() => client!.getCode({ address: user })),
      ]);
      const operatorUntil = isOperator
        ? await findOperatorExpiry(client!, user, { fromBlock: head - OPERATOR_LOG_BLOCKS, toBlock: head })
        : undefined;
      return {
        lastFaucet,
        balanceHandle,
        isOperator,
        operatorUntil,
        delegated7702: isEip7702Delegated(code),
        backToBack: allowsBackToBackWrites(code),
        readAtBlock: head,
      };
    },
  });
}

/**
 * The player's chip balance, decrypted only when this tab is already unlocked for them (never asks for a
 * signature by itself). Undefined while locked, unfunded or loading.
 */
export function useDecryptedBalance(balanceHandle: Hex | undefined) {
  const fhe = useFheClient();
  const { address } = useConnection();
  const unlocked = useUnlockedUser();
  const isUnlocked = Boolean(address && unlocked && unlocked.toLowerCase() === address.toLowerCase());
  const funded = balanceHandle !== undefined && balanceHandle.toLowerCase() !== ZERO_HANDLE;
  const query = useQuery({
    queryKey: ["chip-balance", address, balanceHandle],
    enabled: isUnlocked && funded,
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async () => {
      const handle = balanceHandle as Hex;
      const clear = await fhe.userDecrypt([{ handle, contract: BLUFF_CHIPS_ADDRESS }], {
        label: "Decrypting your chips",
      });
      return clear.get(handle) ?? 0n;
    },
  });
  if (!isUnlocked) return undefined;
  if (balanceHandle !== undefined && !funded) return 0n;
  return query.data;
}
