"use client";

import { formatEther } from "viem";
import { useSwitchChain } from "wagmi";

import { MIN_ETH_WEI } from "@/chain/gates";
import { useWalletGate } from "@/chain/useWalletGate";
import { SEPOLIA_FAUCET_URL } from "@/config/env";
import { METAMASK_DOWNLOAD_URL } from "@/config/links";
import { SEPOLIA_CHAIN_ID } from "@/contracts/addresses";

import styles from "./Gates.module.css";

function Banner({ title, children, action }: { title: string; children: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className={styles.banner} role="status">
      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        <p className={styles.body}>{children}</p>
      </div>
      <div className={styles.action}>{action}</div>
    </div>
  );
}

/** S8: no wallet installed. One action: install one. */
export function WalletGate() {
  const { status } = useWalletGate();
  if (status !== "noWallet") return null;
  return (
    <Banner
      title="No wallet found"
      action={
        <a className="button button-primary" href={METAMASK_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
          Install MetaMask
        </a>
      }
    >
      Bluff runs on Ethereum Sepolia. You need a browser wallet to sign your moves. On a phone, open this page in your
      wallet&apos;s built-in browser.
    </Banner>
  );
}

/** S8: wallet on another network. One action: switch (the wallet adds Sepolia if it is missing). */
export function NetworkGate() {
  const { status } = useWalletGate();
  const switchChain = useSwitchChain();
  if (status !== "wrongChain") return null;
  return (
    <Banner
      title="Wrong network"
      action={
        <button
          type="button"
          className="button button-primary"
          disabled={switchChain.isPending}
          onClick={() => switchChain.mutate({ chainId: SEPOLIA_CHAIN_ID })}
        >
          {switchChain.isPending ? "Confirm in your wallet…" : "Switch to Sepolia"}
        </button>
      }
    >
      Your wallet is on another network. Bluff only runs on the Sepolia testnet.
      {switchChain.error ? " The switch did not go through; try again or switch in your wallet." : ""}
    </Banner>
  );
}

/** S8: not enough Sepolia ETH for gas. One action: open a faucet. */
export function EthBalanceGate() {
  const { status, balanceWei } = useWalletGate();
  if (status !== "noEth" && status !== "lowEth") return null;
  const need = formatEther(MIN_ETH_WEI);
  return (
    <Banner
      title={status === "noEth" ? "No Sepolia ETH" : "Low on Sepolia ETH"}
      action={
        <a className="button button-primary" href={SEPOLIA_FAUCET_URL} target="_blank" rel="noopener noreferrer">
          Get test ETH
        </a>
      }
    >
      Moves are transactions and need a little gas. You have {formatEther(balanceWei ?? 0n)} ETH; about {need} ETH is
      enough to start. Test ETH is free from a faucet.
    </Banner>
  );
}

/** Banners every screen shows once a wallet is connected. */
export function ConnectedGates() {
  return (
    <div className="container">
      <NetworkGate />
      <EthBalanceGate />
    </div>
  );
}
