"use client";

import { useState } from "react";
import { useConnection } from "wagmi";

import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";
import { FheError } from "@/fhe/errors";
import { useFheClient, useUnlockedUser } from "@/fhe/FheProvider";
import { signWithWallet } from "@/fhe/walletSigner";
import { onboardingTimer } from "@/lib/stepTimer";

import { RelayerStatus } from "./RelayerStatus";
import styles from "./UnlockCard.module.css";

/** The free EIP-712 signature that lets this tab decrypt the player's own dice. Hidden once unlocked. */
export function UnlockCard({ context }: { context?: string }) {
  const fhe = useFheClient();
  const { address, chainId } = useConnection();
  const unlocked = useUnlockedUser();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!address || chainId !== SEPOLIA_CHAIN_ID) return null;
  if (unlocked && unlocked.toLowerCase() === address.toLowerCase()) {
    return (
      <p className={styles.done} role="status">
        Unlocked: this tab can read your dice.
      </p>
    );
  }

  async function unlock() {
    if (!address) return;
    setBusy(true);
    setMessage(null);
    try {
      onboardingTimer.prompt("signature");
      await fhe.unlock(address, signWithWallet, { walletChainId: chainId });
    } catch (error) {
      setMessage(
        error instanceof FheError && error.kind !== "unknown"
          ? error.message
          : "You can still play; your dice stay hidden from you until you sign.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="unlock-title">
      <h3 id="unlock-title" className={styles.title}>
        Unlock your dice
      </h3>
      {context ? <p className={styles.context}>{context}</p> : null}
      <p className={styles.text}>
        Sign once so only you can read your dice. Free, no transaction. The key lives only in this tab: closing it makes
        the signature useless (the signature itself is valid 24 h).
      </p>
      <button type="button" className="button button-primary" disabled={busy} onClick={() => void unlock()}>
        {busy ? "Check your wallet…" : "Sign to unlock (free)"}
      </button>
      <RelayerStatus channel="unlock" />
      {message ? (
        <p className={styles.message} role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}
