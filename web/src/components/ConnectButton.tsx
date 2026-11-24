"use client";

import { useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, type Connector } from "wagmi";

import { connectView } from "@/chain/connectState";
import { useHasInjectedWallet, useMounted } from "@/chain/useWalletGate";
import { METAMASK_DOWNLOAD_URL } from "@/config/links";
import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";
import { onboardingTimer } from "@/lib/stepTimer";

import styles from "./ConnectButton.module.css";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** EIP-6963 wallets first; the generic injected connector only when no wallet announced itself. */
function usableConnectors(connectors: readonly Connector[]): Connector[] {
  const announced = connectors.filter((c) => c.id !== "injected");
  return announced.length > 0 ? announced : connectors.filter((c) => c.id === "injected");
}

/** Our own connect control (no wallet kit): connect, pick a wallet when several are installed, disconnect. */
export function ConnectButton() {
  const mounted = useMounted();
  const injected = useHasInjectedWallet();
  const { address, status } = useConnection();
  const connectors = usableConnectors(useConnectors());
  const connect = useConnect();
  const disconnect = useDisconnect();
  const [open, setOpen] = useState(false);

  if (!mounted) {
    return (
      <button type="button" className={`button button-ghost ${styles.button}`} disabled>
        Connect wallet
      </button>
    );
  }

  if (status === "connected" && address) {
    return (
      <div className={styles.wrap}>
        <button
          type="button"
          className={`button button-ghost ${styles.button}`}
          aria-expanded={open}
          aria-controls="account-menu"
          onClick={() => setOpen((v) => !v)}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className="mono">{shortAddress(address)}</span>
        </button>
        {open ? (
          <div id="account-menu" className={styles.menu}>
            <p className={`mono ${styles.full}`}>{address}</p>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                setOpen(false);
                disconnect.mutate();
              }}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (!injected && connectors.every((c) => c.id === "injected")) {
    return (
      <a
        className={`button button-ghost ${styles.button}`}
        href={METAMASK_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Install a wallet
      </a>
    );
  }

  const busy = status === "connecting" || status === "reconnecting" || connect.isPending;
  const view = connectView({ pending: busy, error: connect.error });
  const onlyOne = connectors.length === 1 ? connectors[0] : undefined;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`button button-primary ${styles.button}`}
        disabled={busy}
        aria-expanded={onlyOne ? undefined : open}
        aria-controls={onlyOne ? undefined : "wallet-menu"}
        onClick={() => {
          if (!onlyOne) return setOpen((v) => !v);
          onboardingTimer.prompt("connect");
          connect.mutate({ connector: onlyOne, chainId: SEPOLIA_CHAIN_ID });
        }}
      >
        {busy ? "Waiting for wallet…" : "Connect wallet"}
      </button>
      {open && !onlyOne ? (
        <ul id="wallet-menu" className={styles.menu} aria-label="Choose a wallet">
          {connectors.map((connector) => (
            <li key={connector.uid}>
              <button
                type="button"
                className={`button button-ghost ${styles.walletOption}`}
                onClick={() => {
                  setOpen(false);
                  onboardingTimer.prompt("connect");
                  connect.mutate({ connector, chainId: SEPOLIA_CHAIN_ID });
                }}
              >
                {connector.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {view.kind === "idle" ? null : (
        <p
          className={view.kind === "rejected" || view.kind === "failed" ? styles.error : styles.info}
          role="status"
          aria-live="polite"
        >
          {view.message}
        </p>
      )}
    </div>
  );
}
