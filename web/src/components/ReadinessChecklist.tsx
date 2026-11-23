"use client";

import type { GateStatus } from "@/chain/gates";
import { useWalletGate } from "@/chain/useWalletGate";

import styles from "./ReadinessChecklist.module.css";

const ORDER: readonly GateStatus[] = ["noWallet", "disconnected", "wrongChain", "noEth", "ready"];

const STEPS = [
  { label: "A browser wallet is installed", doneAfter: "noWallet" },
  { label: "Wallet connected", doneAfter: "disconnected" },
  { label: "On the Sepolia network", doneAfter: "wrongChain" },
  { label: "Enough Sepolia ETH for gas", doneAfter: "noEth" },
] as const;

function rank(status: GateStatus): number {
  if (status === "lowEth") return ORDER.indexOf("noEth");
  return ORDER.indexOf(status);
}

/** What the player still has to fix before onboarding; the gate banners carry the one action for each. */
export function ReadinessChecklist() {
  const { status } = useWalletGate();
  const checking = status === "checking";
  return (
    <ol className={styles.list} aria-busy={checking}>
      {STEPS.map((step) => {
        const done = !checking && rank(status) > ORDER.indexOf(step.doneAfter);
        return (
          <li key={step.label} className={done ? styles.done : styles.todo}>
            <span className={styles.mark} aria-hidden="true">
              {done ? "✓" : "•"}
            </span>
            {step.label}
            <span className="visually-hidden">{checking ? ": checking" : done ? ": done" : ": to do"}</span>
          </li>
        );
      })}
    </ol>
  );
}
