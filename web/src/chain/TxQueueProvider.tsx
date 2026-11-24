"use client";

import { createContext, useCallback, useContext, useMemo, useReducer, useRef } from "react";
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hex, TransactionReceipt } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";

import { toTxError, type TxError } from "@/lib/errors";
import { onboardingTimer } from "@/lib/stepTimer";

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

type AnyWrite = WriteRequest<Abi, string>;

/** Result of a write: the receipts on success, else the decoded error (null when it never started). */
export type TxOutcome<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: TxError | null };

interface TxQueueValue {
  state: TxState;
  busy: boolean;
  reason: string | null;
  /** Runs one write: simulate -> estimate -> wallet -> receipt. Resolves with the receipt when it succeeded. */
  run: <abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable">>(
    request: WriteRequest<abi, fn>,
  ) => Promise<TxOutcome<TransactionReceipt>>;
  /**
   * Several writes. `backToBack` (plain EOAs only, never EIP-7702 accounts) sends each one to the wallet without
   * waiting for the previous receipt; otherwise one at a time. Resolves with every receipt, or null on failure.
   */
  runBatch: (
    requests: readonly AnyWrite[],
    options: { backToBack: boolean },
  ) => Promise<TxOutcome<TransactionReceipt[]>>;
  reset: () => void;
}

const TxQueueContext = createContext<TxQueueValue | null>(null);

export function TxQueueProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(txReducer, initialTxState);
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  // Synchronous guard: two clicks in the same frame must not both pass the `busy` check.
  const lock = useRef(false);

  const runBatch = useCallback<TxQueueValue["runBatch"]>(
    async (requests, { backToBack }) => {
      if (requests.length === 0 || lock.current || !publicClient || !walletClient) return { ok: false, error: null };
      lock.current = true;
      const first = requests[0] as AnyWrite;
      dispatch({ type: "start", label: first.label });
      try {
        const account = walletClient.account.address;
        const calls = requests.map(
          (r) => ({ address: r.address, abi: r.abi, functionName: r.functionName, args: r.args, account }) as const,
        );

        async function prepare(call: (typeof calls)[number]): Promise<bigint> {
          await publicClient!.simulateContract(call as never);
          return gasWithMargin(await publicClient!.estimateContractGas(call as never));
        }
        async function send(call: (typeof calls)[number], gas: bigint): Promise<Hex> {
          onboardingTimer.prompt("transaction");
          // Fees are left to the wallet; the gas limit is explicit (never the wallet's own guess, see txQueue.ts).
          return walletClient!.writeContract({ ...call, gas, chain: walletClient!.chain } as never);
        }
        async function mined(hash: Hex): Promise<TransactionReceipt> {
          const receipt = await publicClient!.waitForTransactionReceipt({ hash });
          if (receipt.status === "success") pinReadsTo(receipt.blockNumber);
          return receipt;
        }

        const receipts: TransactionReceipt[] = [];
        if (backToBack) {
          // Prepare all, then prompt for each without waiting for receipts (about one block saved per write).
          const gases: bigint[] = [];
          for (const call of calls) gases.push(await prepare(call));
          dispatch({ type: "simulated" });
          dispatch({ type: "estimated", gas: gases[0] as bigint });
          const hashes: Hex[] = [];
          for (let i = 0; i < calls.length; i++) {
            if (i > 0)
              dispatch({ type: "nextPrompt", label: (requests[i] as AnyWrite).label, gas: gases[i] as bigint });
            const hash = await send(calls[i] as (typeof calls)[number], gases[i] as bigint);
            hashes.push(hash);
            dispatch({ type: "submitted", hash });
          }
          for (const hash of hashes) receipts.push(await mined(hash));
        } else {
          for (let i = 0; i < calls.length; i++) {
            if (i > 0) dispatch({ type: "start", label: (requests[i] as AnyWrite).label });
            const gas = await prepare(calls[i] as (typeof calls)[number]);
            dispatch({ type: "simulated" });
            dispatch({ type: "estimated", gas });
            const hash = await send(calls[i] as (typeof calls)[number], gas);
            dispatch({ type: "submitted", hash });
            const receipt = await mined(hash);
            receipts.push(receipt);
            if (receipt.status !== "success") break;
            if (i < calls.length - 1) {
              dispatch({ type: "mined", blockNumber: receipt.blockNumber, success: true });
            }
          }
        }
        const last = receipts[receipts.length - 1] as TransactionReceipt;
        const ok = receipts.length === requests.length && receipts.every((r) => r.status === "success");
        dispatch({ type: "mined", blockNumber: last.blockNumber, success: ok });
        return ok
          ? { ok: true, value: receipts }
          : { ok: false, error: { kind: "revertedOnchain", message: "The transaction was mined but reverted." } };
      } catch (error) {
        const txError = toTxError(error);
        dispatch({ type: "failed", error: txError });
        return { ok: false, error: txError };
      } finally {
        lock.current = false;
      }
    },
    [publicClient, walletClient],
  );

  const run = useCallback<TxQueueValue["run"]>(
    async (request) => {
      const outcome = await runBatch([request as unknown as AnyWrite], { backToBack: false });
      return outcome.ok ? { ok: true, value: outcome.value[0] as TransactionReceipt } : outcome;
    },
    [runBatch],
  );

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  const value = useMemo<TxQueueValue>(
    () => ({ state, busy: isBusy(state), reason: busyReason(state), run, runBatch, reset }),
    [state, run, runBatch, reset],
  );
  return <TxQueueContext.Provider value={value}>{children}</TxQueueContext.Provider>;
}

export function useTxQueue(): TxQueueValue {
  const value = useContext(TxQueueContext);
  if (!value) throw new Error("useTxQueue must be used inside <TxQueueProvider>");
  return value;
}
