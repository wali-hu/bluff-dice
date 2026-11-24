"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useReducer, useRef } from "react";
import type { Address, PublicClient } from "viem";
import { useConnection, usePublicClient } from "wagmi";
import {
  connect,
  getCapabilities,
  getConnection,
  getConnectors,
  sendCalls,
  switchChain,
  waitForCallsStatus,
} from "wagmi/actions";

import { bluffChipsAbi, bluffDiceAbi } from "@/contracts/abi";
import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS, SEPOLIA_CHAIN_ID } from "@/contracts/addresses";
import { useFheClient, useUnlockedUser } from "@/fhe/FheProvider";
import { signWithWallet } from "@/fhe/walletSigner";
import { defaultDescribeContext, type TxError } from "@/lib/errors";
import { groupTables } from "@/lib/lobby";
import { hasChips, nextFaucetAt, OPERATOR_TTL_SECONDS, operatorReady } from "@/lib/onboarding";
import {
  type AtomicCapability,
  atomicStatusOf,
  classifyBatchError,
  CONNECT_AND_SWITCH,
  decideSeatPath,
  type DoneSet,
  initialPlayRun,
  type PlannedCall,
  planSeat,
  playReducer,
  type PlayStep,
  type SeatPath,
  seatSituation,
  type SeatTarget,
  UPGRADE_NOTICE,
  USER_REJECTED,
} from "@/lib/playNow";
import { onboardingTimer } from "@/lib/stepTimer";

import { walletErrorCode } from "./connectState";
import { getLobbyTables, tableIdFromReceipt } from "./discovery";
import { pinReadsTo } from "./readPin";
import { chooseSeatTarget, stillJoinable } from "./seatTarget";
import { useTxQueue } from "./TxQueueProvider";
import { useLobbyTables } from "./useLobby";
import { fetchPlayerReads, usePlayerReads, type PlayerChainReads } from "./usePlayerReads";
import { wagmiConfig } from "./wagmi";
import { authorizeWrite, createWrite, faucetWrite, joinWrite } from "./writes";

/** Thrown inside a run to stop at a step with words for the player. */
class Stop extends Error {
  constructor(
    readonly step: PlayStep,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

const REJECTED_TEXT = "You cancelled in the wallet. Nothing after this step was sent.";
const BATCH_WAIT_MS = 300_000;

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/** EIP-6963 wallets first (MetaMask preferred when several announce), else the generic injected connector. */
function pickConnector() {
  const all = getConnectors(wagmiConfig);
  const announced = all.filter((c) => c.id !== "injected");
  return announced.find((c) => c.id === "io.metamask") ?? announced[0] ?? all.find((c) => c.id === "injected");
}

/** The EIP-5792 call for one planned step (wagmi `sendCalls` accepts `{ to, abi, functionName, args }`). */
function toCall(call: PlannedCall) {
  switch (call.kind) {
    case "faucet":
      return { to: BLUFF_CHIPS_ADDRESS, abi: bluffChipsAbi, functionName: "faucet", args: [] } as const;
    case "authorize":
      return {
        to: BLUFF_CHIPS_ADDRESS,
        abi: bluffChipsAbi,
        functionName: "setOperator",
        // `until` in SECONDS (uint48), never milliseconds.
        args: [BLUFF_DICE_ADDRESS, Number(nowSeconds() + OPERATOR_TTL_SECONDS)],
      } as const;
    case "join":
      return { to: BLUFF_DICE_ADDRESS, abi: bluffDiceAbi, functionName: "joinTable", args: [call.tableId] } as const;
    case "create":
      return {
        to: BLUFF_DICE_ADDRESS,
        abi: bluffDiceAbi,
        functionName: "createTable",
        args: [call.stake, call.players],
      } as const;
  }
}

function txStopText(error: TxError | null): string {
  if (!error) return "Another transaction is still open in your wallet. Finish it, then press Try again.";
  return error.kind === "rejected" ? REJECTED_TEXT : error.message;
}

/** "Play now": runs every remaining onboarding step in order; the player only confirms in the wallet. */
export function usePlayNow(requestedTableId?: bigint) {
  const [run, dispatch] = useReducer(playReducer, initialPlayRun);
  const running = useRef(false);
  // "Do it one by one": read synchronously by the next start() (state would be one render late).
  const preferSequential = useRef(false);
  // "Join this table too": the player saw their seat at another table and chose to take a second one.
  const allowAnotherSeat = useRef(false);
  const client = usePublicClient();
  const tx = useTxQueue();
  const fhe = useFheClient();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { address, chainId, status } = useConnection();
  const reads = usePlayerReads();
  const lobby = useLobbyTables();
  const unlocked = useUnlockedUser();

  const connected = status === "connected";
  const onSepolia = connected && chainId === SEPOLIA_CHAIN_ID;
  // Only a seat at the table this run is about counts as "seated" (BluffDice allows seats at several tables).
  const situation =
    lobby.data && address
      ? seatSituation(
          groupTables(lobby.data, address).mine.map((e) => e.id),
          requestedTableId,
        )
      : ({ kind: "free" } as const);
  const seatedId = situation.kind === "atTarget" ? situation.tableId : undefined;
  const now = nowSeconds();
  const done: DoneSet = {
    connect: connected,
    network: onSepolia,
    claim: seatedId !== undefined || (reads.data !== undefined && hasChips(reads.data)),
    authorize:
      seatedId !== undefined || (reads.data !== undefined && operatorReady({ ...reads.data, nowSeconds: now })),
    seat: seatedId !== undefined,
    sign: Boolean(onSepolia && address && unlocked && unlocked.toLowerCase() === address.toLowerCase()),
  };

  /** Sequential path: TxQueue writes (estimate x1.2), faucet + authorize back to back for plain EOAs. */
  const seatSequentially = useCallback(
    async (
      pc: PublicClient,
      user: Address,
      r: PlayerChainReads,
      calls: readonly PlannedCall[],
      initialTarget: SeatTarget,
    ): Promise<bigint> => {
      const needFaucet = calls.some((c) => c.kind === "faucet");
      const needAuth = calls.some((c) => c.kind === "authorize");
      if (needFaucet && needAuth && r.backToBack) {
        dispatch({ type: "active", steps: ["claim", "authorize"], status: "Confirm two transactions in your wallet…" });
        const outcome = await tx.runBatch([faucetWrite(), authorizeWrite(nowSeconds())], { backToBack: true });
        if (!outcome.ok) throw new Stop("claim", txStopText(outcome.error));
        dispatch({ type: "done", steps: ["claim", "authorize"] });
      } else {
        if (needFaucet) {
          dispatch({ type: "active", steps: ["claim"], status: "Confirm “Claim chips” in your wallet…" });
          const outcome = await tx.run(faucetWrite());
          if (!outcome.ok) throw new Stop("claim", txStopText(outcome.error));
          dispatch({ type: "done", steps: ["claim"] });
        }
        if (needAuth) {
          dispatch({ type: "active", steps: ["authorize"], status: "Confirm “Authorize the table” in your wallet…" });
          const outcome = await tx.run(authorizeWrite(nowSeconds()));
          if (!outcome.ok) throw new Stop("authorize", txStopText(outcome.error));
          dispatch({ type: "done", steps: ["authorize"] });
        }
      }

      let target = initialTarget;
      for (let attempt = 0; attempt < 2; attempt++) {
        dispatch({ type: "active", steps: ["seat"], status: "Confirm your seat in your wallet…" });
        const outcome = await tx.run(
          target.kind === "join" ? joinWrite(target.tableId) : createWrite(target.stake, target.players),
        );
        if (outcome.ok) {
          if (target.kind === "join") return target.tableId;
          const id = tableIdFromReceipt(outcome.value);
          if (id === undefined)
            throw new Stop("seat", "The table was created but its id was not found. Open the lobby.");
          return id;
        }
        // The table filled between the choice and the join: choose again once.
        if (target.kind === "join" && outcome.error?.kind === "contract" && outcome.error.name === "WrongPhase") {
          tx.reset();
          target = await chooseSeatTarget(pc, user, { exclude: target.tableId });
          continue;
        }
        throw new Stop("seat", txStopText(outcome.error));
      }
      throw new Stop("seat", "Tables keep filling up before your seat lands. Press Try again.");
    },
    [tx],
  );

  /** EIP-5792 path: one atomic `wallet_sendCalls`; null = fall back to one by one. */
  const seatInOneBatch = useCallback(
    async (
      user: Address,
      calls: readonly PlannedCall[],
      steps: readonly PlayStep[],
      path: SeatPath,
    ): Promise<bigint | null> => {
      dispatch({
        type: "active",
        steps,
        status:
          path === "batchWithUpgrade"
            ? `${UPGRADE_NOTICE} Confirm in your wallet…`
            : `Confirm ${steps.length} steps in one wallet confirmation…`,
      });
      let submitted = false;
      try {
        const result = await tx.runExclusive("Play now", async () => {
          onboardingTimer.prompt("transaction"); // one batch = one wallet prompt (K)
          const sent = await sendCalls(wagmiConfig, {
            account: user,
            chainId: SEPOLIA_CHAIN_ID,
            calls: calls.map(toCall),
            forceAtomic: true, // all or nothing; never a silent non-atomic fallback
          });
          submitted = true;
          dispatch({ type: "status", status: "Waiting for your steps to be mined (usually about 12 s)…" });
          return waitForCallsStatus(wagmiConfig, { id: sent.id, timeout: BATCH_WAIT_MS });
        });
        if (result === null) throw new Stop(steps[0] ?? "seat", txStopText(null));
        const receipts = result.receipts ?? [];
        if (result.status !== "success" || receipts.some((r) => r.status !== "success")) {
          throw new Stop(
            steps[0] ?? "seat",
            "Your steps did not go through. A batch is all or nothing, so nothing changed. Press Try again.",
            `status ${String(result.status)} (${result.statusCode})`,
          );
        }
        const last = receipts.reduce((max, r) => (r.blockNumber > max ? r.blockNumber : max), 0n);
        if (last > 0n) pinReadsTo(last);
        onboardingTimer.note(path === "batchWithUpgrade" ? "path: batch (after smart-account offer)" : "path: batch");
        const seatCall = calls[calls.length - 1];
        if (seatCall?.kind === "join") return seatCall.tableId;
        const id = tableIdFromReceipt({ logs: receipts.flatMap((r) => r.logs) });
        if (id === undefined) throw new Stop("seat", "The table was created but its id was not found. Open the lobby.");
        return id;
      } catch (error) {
        if (error instanceof Stop) throw error;
        const failure = classifyBatchError(error, submitted);
        if (failure.kind === "rejected") throw new Stop(steps[0] ?? "seat", REJECTED_TEXT);
        if (failure.kind === "failed") {
          throw new Stop(steps[0] ?? "seat", "Your steps did not go through. Press Try again.", failure.detail);
        }
        onboardingTimer.note("batch refused by the wallet: one by one");
        dispatch({ type: "status", status: "Your wallet cannot bundle these steps. Continuing one by one…" });
        return null;
      }
    },
    [tx],
  );

  const start = useCallback(async () => {
    if (running.current || !client) return;
    running.current = true;
    dispatch({ type: "start" });
    let step: PlayStep = "connect";
    try {
      // 1-2. Connect and Sepolia in one action (wagmi connect({ chainId }) switches right after connecting).
      let conn = getConnection(wagmiConfig);
      if (conn.status !== "connected") {
        dispatch({ type: "active", steps: ["connect", "network"], status: `${CONNECT_AND_SWITCH}…` });
        const connector = pickConnector();
        if (!connector) throw new Stop("connect", "No browser wallet found. Install MetaMask, then press Play now.");
        onboardingTimer.prompt("connect");
        try {
          await connect(wagmiConfig, { connector, chainId: SEPOLIA_CHAIN_ID });
        } catch (error) {
          throw new Stop(
            "connect",
            walletErrorCode(error) === USER_REJECTED
              ? REJECTED_TEXT
              : "Could not connect your wallet. Press Try again.",
          );
        }
        conn = getConnection(wagmiConfig);
      }
      dispatch({ type: "done", steps: ["connect"] });
      step = "network";
      if (conn.chainId !== SEPOLIA_CHAIN_ID) {
        dispatch({ type: "active", steps: ["network"], status: "Approve the switch to Sepolia in your wallet…" });
        onboardingTimer.prompt("switchNetwork");
        try {
          await switchChain(wagmiConfig, { chainId: SEPOLIA_CHAIN_ID });
        } catch (error) {
          throw new Stop(
            "network",
            walletErrorCode(error) === USER_REJECTED
              ? REJECTED_TEXT
              : "Switch your wallet to Sepolia, then press Try again.",
          );
        }
      }
      dispatch({ type: "done", steps: ["network"] });
      const user = getConnection(wagmiConfig).address as Address;

      // 3-5. Chips, authorization and seat: only what is still needed.
      step = "seat";
      dispatch({ type: "status", status: "Reading your chips and permissions on Sepolia…" });
      const [r, lobbyNow] = await Promise.all([fetchPlayerReads(client, user), getLobbyTables(client)]);
      const where = seatSituation(
        groupTables(lobbyNow, user).mine.map((e) => e.id),
        requestedTableId,
      );
      if (where.kind === "elsewhere" && !allowAnotherSeat.current) {
        // Never pretend to join: say where they already sit and let them choose (open it, or take a second seat).
        dispatch({ type: "seatedElsewhere", tableId: where.tableId });
        return;
      }
      let seatId = where.kind === "atTarget" ? where.tableId : undefined;
      if (seatId === undefined) {
        let target = await chooseSeatTarget(client, user, { requested: requestedTableId, lobby: lobbyNow });
        const t = nowSeconds();
        const planInput = {
          claimed: hasChips(r),
          inCooldown: nextFaucetAt(r.lastFaucet, t) !== undefined,
          operatorValid: operatorReady({ ...r, nowSeconds: t }),
        };
        let plan = planSeat({ ...planInput, target });
        if (!plan.ok) {
          const next = nextFaucetAt(r.lastFaucet, t);
          throw new Stop(
            "claim",
            `You have no chips yet. Next free chips at ${next ? defaultDescribeContext.formatTime(next) : "a later time"}.`,
          );
        }
        if (planInput.claimed) dispatch({ type: "done", steps: ["claim"] });
        if (planInput.operatorValid) dispatch({ type: "done", steps: ["authorize"] });

        let atomic: AtomicCapability = "missing";
        if (plan.calls.length > 1 && !preferSequential.current) {
          dispatch({ type: "status", status: "Asking your wallet what it supports…" });
          atomic = await getCapabilities(wagmiConfig, { account: user, chainId: SEPOLIA_CHAIN_ID })
            .then((caps) => atomicStatusOf(caps))
            .catch((): AtomicCapability => "error");
        }
        let path = decideSeatPath(plan.calls.length, atomic, preferSequential.current);
        dispatch({ type: "path", path });

        if (path === "batch" || path === "batchWithUpgrade") {
          // "A batch never reverts": re-read the target at the latest block right before sending.
          if (target.kind === "join" && !(await stillJoinable(client, target.tableId, user))) {
            target = await chooseSeatTarget(client, user, { exclude: target.tableId });
            plan = planSeat({ ...planInput, target });
          }
          if (plan.ok) {
            const id = await seatInOneBatch(user, plan.calls, plan.steps, path);
            if (id !== null) seatId = id;
            else path = "sequential";
          }
        }
        if (seatId === undefined && plan.ok) {
          onboardingTimer.note(path === "single" ? "path: single transaction" : "path: one by one");
          dispatch({ type: "path", path });
          seatId = await seatSequentially(client, user, r, plan.calls, target);
        }
      }
      dispatch({ type: "done", steps: ["claim", "authorize", "seat"] });
      onboardingTimer.seated();
      void queryClient.invalidateQueries();
      if (seatId === undefined) throw new Stop("seat", "No seat was taken. Press Try again.");

      // 6. The free unlock signature, then the table.
      step = "sign";
      const session = getConnection(wagmiConfig).address;
      if (!(unlocked && session && unlocked.toLowerCase() === session.toLowerCase())) {
        dispatch({
          type: "active",
          steps: ["sign"],
          status: "Sign once so only you can read your dice (free, no transaction)…",
        });
        onboardingTimer.prompt("signature");
        try {
          await fhe.unlock(user, signWithWallet, { walletChainId: SEPOLIA_CHAIN_ID });
        } catch {
          throw new Stop(
            "sign",
            `You have a seat at table #${seatId}. You can still play; your dice stay hidden from you until you sign.`,
          );
        }
      }
      dispatch({ type: "done", steps: ["sign"] });
      onboardingTimer.finish();
      dispatch({ type: "finished" });
      router.push(`/table/${seatId}`);
    } catch (error) {
      if (error instanceof Stop) {
        dispatch({ type: "failed", step: error.step, message: error.message, detail: error.detail });
      } else {
        dispatch({
          type: "failed",
          step,
          message: "Something went wrong while reading Sepolia. Press Try again.",
          detail: error instanceof Error ? error.message.slice(0, 400) : String(error),
        });
      }
    } finally {
      running.current = false;
    }
  }, [client, fhe, queryClient, requestedTableId, router, seatInOneBatch, seatSequentially, unlocked]);

  const oneByOne = useCallback(() => {
    preferSequential.current = true;
    dispatch({ type: "oneByOne" });
  }, []);

  /** After "you already sit at table #N": the player explicitly takes a seat here as well. */
  const joinAnyway = useCallback(() => {
    allowAnotherSeat.current = true;
    void start();
  }, [start]);

  return { run, done, seatedId, start, oneByOne, joinAnyway };
}
