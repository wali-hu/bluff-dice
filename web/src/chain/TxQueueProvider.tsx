"use client";

import { createContext, useCallback, useContext, useMemo, useReducer, useRef } from "react";
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";

import { toTxError } from "@/lib/errors";

import { pinReadsTo } from "./readPin";
import { busyReason, gasWithMargin, initialTxState, isBusy, txReducer, type TxState } from "./txQueue";

export interface WriteRequest<
  abi extends Abi = Abi,
  functionName extends ContractFunctionName<abi, "nonpayable"> = ContractFunctionName<abi, "nonpayable">,
> {
  /** Short words for the UI, e.g. "Claim chips". */
  label: string;
  address: Address;
  abi: abi;
  functionName: functionName;
  args: ContractFunctionArgs<abi, "nonpayable", functionName>;
}

interface TxQueueValue {
  state: TxState;
  busy: boolean;
  reason: string | null;
  /** Runs one write through simulate -> estimate -> wallet -> receipt. Resolves true when confirmed. */
  run: <abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable">>(
    request: WriteRequest<abi, fn>,
  ) => Promise<boolean>;
  reset: () => void;
}

const TxQueueContext = createContext<TxQueueValue | null>(null);

export function TxQueueProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(txReducer, initialTxState);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  // Synchronous guard: two clicks in the same frame must not both pass the `busy` check.
  const lock = useRef(false);

  const run = useCallback<TxQueueValue["run"]>(
    async (request) => {
      if (lock.current || !publicClient || !walletClient) return false;
      lock.current = true;
      dispatch({ type: "start", label: request.label });
      try {
        const account = walletClient.account.address;
        const call = {
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args,
          account,
        } as const;
        await publicClient.simulateContract(call as never);
        dispatch({ type: "simulated" });
        const gas = gasWithMargin(await publicClient.estimateContractGas(call as never));
        dispatch({ type: "estimated", gas });
        // Fees are left to the wallet; the gas limit is explicit (never the wallet's own guess, see txQueue.ts).
        const hash = await walletClient.writeContract({ ...call, gas, chain: walletClient.chain } as never);
        dispatch({ type: "submitted", hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "success") pinReadsTo(receipt.blockNumber);
        dispatch({ type: "mined", blockNumber: receipt.blockNumber, success: receipt.status === "success" });
        return receipt.status === "success";
      } catch (error) {
        dispatch({ type: "failed", error: toTxError(error) });
        return false;
      } finally {
        lock.current = false;
      }
    },
    [publicClient, walletClient],
  );

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  const value = useMemo<TxQueueValue>(
    () => ({ state, busy: isBusy(state), reason: busyReason(state), run, reset }),
    [state, run, reset],
  );
  return <TxQueueContext.Provider value={value}>{children}</TxQueueContext.Provider>;
}

export function useTxQueue(): TxQueueValue {
  const value = useContext(TxQueueContext);
  if (!value) throw new Error("useTxQueue must be used inside <TxQueueProvider>");
  return value;
}
