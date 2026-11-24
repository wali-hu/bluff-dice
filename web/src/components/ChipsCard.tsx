"use client";

import { useState } from "react";
import type { Hex } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { getBalanceHandle } from "@/chain/reads";
import { BLUFF_CHIPS_ADDRESS, SEPOLIA_CHAIN_ID } from "@/contracts/addresses";
import { FheError } from "@/fhe/errors";
import { useFheClient, useUnlockedUser } from "@/fhe/FheProvider";
import { ZERO_HANDLE } from "@/fhe/sdkClient";
import { signWithWallet } from "@/fhe/walletSigner";
import { formatChips } from "@/lib/chips";
import { onboardingTimer } from "@/lib/stepTimer";

import styles from "./ChipsCard.module.css";
import { RelayerStatus } from "./RelayerStatus";

interface Reading {
  user: string;
  chips: bigint;
  unlockMs?: number;
  decryptMs: number;
  zero: boolean;
}

/**
 * Live check of the browser user-decrypt path (step E3): one free signature, then the connected wallet's
 * encrypted BluffChips balance is decrypted for this wallet only.
 */
export function ChipsCard() {
  const client = useFheClient();
  const publicClient = usePublicClient();
  const { address, chainId, status } = useConnection();
  const unlocked = useUnlockedUser();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);

  const ready = status === "connected" && address !== undefined && chainId === SEPOLIA_CHAIN_ID;
  const isUnlocked = ready && unlocked?.toLowerCase() === address.toLowerCase();
  const shown =
    reading && address && reading.user.toLowerCase() === address.toLowerCase() && isUnlocked ? reading : null;

  async function decrypt(unlockMs?: number) {
    if (!address || !publicClient) return;
    const handle: Hex = await getBalanceHandle(publicClient, address);
    const t0 = performance.now();
    if (handle.toLowerCase() === ZERO_HANDLE) {
      setReading({ user: address, chips: 0n, unlockMs, decryptMs: 0, zero: true });
      return;
    }
    const clear = await client.userDecrypt([{ handle, contract: BLUFF_CHIPS_ADDRESS }], {
      label: "Decrypting your chips",
    });
    setReading({
      user: address,
      chips: clear.get(handle) ?? 0n,
      unlockMs,
      decryptMs: performance.now() - t0,
      zero: false,
    });
  }

  async function run(withUnlock: boolean) {
    if (!address) return;
    setBusy(true);
    setMessage(null);
    try {
      let unlockMs: number | undefined;
      if (withUnlock) {
        const t0 = performance.now();
        onboardingTimer.prompt("signature");
        await client.unlock(address, signWithWallet, { walletChainId: chainId });
        unlockMs = performance.now() - t0;
      }
      await decrypt(unlockMs);
    } catch (error) {
      setMessage(
        error instanceof FheError
          ? error.message
          : /reject|denied/i.test(String(error))
            ? "Signature cancelled. You can still play; your dice stay hidden from you until you sign."
            : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="chips-title">
      <h2 id="chips-title" className={styles.title}>
        Your chips
      </h2>
      {!ready ? (
        <p className={styles.muted}>Connect your wallet on Sepolia to read your encrypted chip balance.</p>
      ) : (
        <>
          <p className={styles.muted}>
            Your balance is encrypted on chain. Sign once (free, no transaction) so only you can decrypt it. The
            permission lives in this tab only and ends when you close it.
          </p>
          <div className={styles.actions}>
            {isUnlocked ? (
              <button type="button" className="button button-ghost" disabled={busy} onClick={() => void run(false)}>
                {busy ? "Decrypting…" : "Decrypt again"}
              </button>
            ) : (
              <button type="button" className="button button-primary" disabled={busy} onClick={() => void run(true)}>
                {busy ? "Check your wallet…" : "Unlock (free signature)"}
              </button>
            )}
          </div>
          <RelayerStatus channel="unlock" />
          <RelayerStatus channel="userDecrypt" hint="usually 5-10 s" onRetry={() => void run(false)} />
          {message ? (
            <p className={styles.error} role="alert">
              {message}
            </p>
          ) : null}
          {shown ? (
            <div className={styles.result}>
              <p className={styles.amount}>
                <span className="mono">{formatChips(shown.chips)}</span> BCHIP
              </p>
              <p className={styles.muted}>
                {shown.zero
                  ? "No chips yet (your balance was never funded)."
                  : `Decrypted for ${address?.slice(0, 6)}…${address?.slice(-4)} only.`}{" "}
                {shown.unlockMs !== undefined ? `Unlock ${Math.round(shown.unlockMs)} ms, ` : ""}
                decrypt {Math.round(shown.decryptMs)} ms.
              </p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
