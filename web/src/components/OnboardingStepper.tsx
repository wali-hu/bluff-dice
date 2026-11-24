"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect } from "react";
import { useConnection, useSwitchChain } from "wagmi";

import { useTxQueue } from "@/chain/TxQueueProvider";
import { PLAYER_READS_KEY, usePlayerReads, type PlayerChainReads } from "@/chain/usePlayerReads";
import { useMounted } from "@/chain/useWalletGate";
import { authorizeWrite, faucetWrite } from "@/chain/writes";
import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";
import { currentStep, ONBOARDING_STEPS, operatorReady, stepIndex, type OnboardingStep } from "@/lib/onboarding";
import { onboardingTimer } from "@/lib/stepTimer";
import { useNow } from "@/lib/useNow";

import { ConnectButton } from "./ConnectButton";
import { JoinPanel } from "./JoinPanel";
import styles from "./Onboarding.module.css";
import { TxStatus } from "./TxStatus";
import { EncryptedAmountNote } from "@/components/EncryptedAmountNote";

const TITLES: Record<OnboardingStep, string> = {
  connect: "Connect your wallet",
  network: "Switch to Sepolia",
  claim: "Claim free chips",
  authorize: "Authorize the table",
  join: "Take a seat",
};

const STATE_CLASS = { done: styles.stepDone, current: styles.stepCurrent, todo: styles.stepTodo } as const;

function nowSecondsFrom(now: number): bigint {
  return BigInt(Math.floor(now / 1000));
}

/** S2: Connect -> Sepolia -> Claim chips -> Authorize table -> Join. Each step is skipped when already done. */
export function OnboardingStepper() {
  const mounted = useMounted();
  const now = useNow();
  const { status, chainId } = useConnection();
  const reads = usePlayerReads();
  const nowSeconds = nowSecondsFrom(now);

  const step = mounted
    ? currentStep({
        connected: status === "connected",
        chainId,
        lastFaucet: reads.data?.lastFaucet,
        balanceHandle: reads.data?.balanceHandle,
        isOperator: reads.data?.isOperator,
        operatorUntil: reads.data?.operatorUntil,
        nowSeconds,
      })
    : "loading";

  useEffect(() => {
    if (step !== "loading") onboardingTimer.enter(step);
  }, [step]);
  useEffect(() => {
    if (reads.data?.delegated7702) onboardingTimer.note("EIP-7702 account: one transaction at a time");
  }, [reads.data?.delegated7702]);

  const activeIndex = step === "loading" ? -1 : stepIndex(step);

  return (
    <div className={styles.stepper}>
      <ol className={styles.steps}>
        {ONBOARDING_STEPS.map((s, i) => {
          const state = i < activeIndex ? "done" : i === activeIndex ? "current" : "todo";
          return (
            <li
              key={s}
              className={`${styles.step} ${STATE_CLASS[state]}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className={styles.marker} aria-hidden="true">
                {state === "done" ? "✓" : i + 1}
              </span>
              <span>{TITLES[s]}</span>
              <span className="visually-hidden">
                {state === "done" ? " (done)" : state === "current" ? " (now)" : ""}
              </span>
            </li>
          );
        })}
      </ol>

      <section className={styles.current} aria-live="polite">
        {step === "loading" ? (
          <p className={styles.muted}>Reading your wallet&apos;s chips and permissions on Sepolia…</p>
        ) : (
          <>
            <h2 className={styles.currentTitle}>{TITLES[step]}</h2>
            {step === "connect" ? <ConnectPanel /> : null}
            {step === "network" ? <NetworkPanel /> : null}
            {step === "claim" && reads.data ? <ClaimPanel reads={reads.data} nowSeconds={nowSeconds} /> : null}
            {step === "authorize" ? <AuthorizePanel nowSeconds={nowSeconds} /> : null}
            {step === "join" && reads.data ? <JoinPanel reads={reads.data} /> : null}
            <TxStatus />
          </>
        )}
        {reads.isError ? (
          <p className={styles.muted} role="alert">
            Could not read Sepolia right now. Retrying automatically…
          </p>
        ) : null}
      </section>
      <p className={styles.muted}>
        Prefer to choose a table? <Link href="/lobby">Open the lobby</Link>.
      </p>
    </div>
  );
}

function ConnectPanel() {
  return (
    <div className={styles.panel}>
      <p className={styles.muted}>Bluff runs on the Ethereum Sepolia testnet. Your wallet signs every move.</p>
      <ConnectButton />
    </div>
  );
}

function NetworkPanel() {
  const switchChain = useSwitchChain();
  return (
    <div className={styles.panel}>
      <p className={styles.muted}>Your wallet is on another network.</p>
      <button
        type="button"
        className="button button-primary"
        disabled={switchChain.isPending}
        onClick={() => {
          onboardingTimer.prompt("switchNetwork");
          switchChain.mutate({ chainId: SEPOLIA_CHAIN_ID });
        }}
      >
        {switchChain.isPending ? "Confirm in your wallet…" : "Switch to Sepolia"}
      </button>
    </div>
  );
}

function useRefreshReads() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [PLAYER_READS_KEY] });
}

function ClaimPanel({ reads, nowSeconds }: { reads: PlayerChainReads; nowSeconds: bigint }) {
  const tx = useTxQueue();
  const refresh = useRefreshReads();
  // Plain EOAs may send both writes back to back (about one block saved); EIP-7702 accounts one at a time.
  const both = reads.backToBack && !operatorReady({ ...reads, nowSeconds });
  async function claim() {
    const outcome = both
      ? await tx.runBatch([faucetWrite(), authorizeWrite(nowSeconds)], { backToBack: true })
      : await tx.run(faucetWrite());
    if (both && outcome.ok) onboardingTimer.note("faucet + authorize sent back to back");
    await refresh();
  }
  return (
    <div className={styles.panel}>
      <p className={styles.muted}>
        1,000 free test chips (BCHIP), once a day. Your balance is encrypted: only you can read it.
        {both ? " The table authorization is asked right after, in a second wallet prompt." : ""}
      </p>
      <button type="button" className="button button-primary" disabled={tx.busy} onClick={() => void claim()}>
        {both ? "Claim chips and authorize (2 prompts)" : "Claim 1,000 chips"}
      </button>
      <EncryptedAmountNote />
    </div>
  );
}

function AuthorizePanel({ nowSeconds }: { nowSeconds: bigint }) {
  const tx = useTxQueue();
  const refresh = useRefreshReads();
  return (
    <div className={styles.panel}>
      <p className={styles.muted}>
        Lets the game contract take exactly your stake when you join. It expires by itself after 10 minutes.
      </p>
      <button
        type="button"
        className="button button-primary"
        disabled={tx.busy}
        onClick={() => void tx.run(authorizeWrite(nowSeconds)).then(() => refresh())}
      >
        Authorize the table
      </button>
    </div>
  );
}
