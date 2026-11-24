"use client";

import { useState } from "react";
import type { Address, PublicClient } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { getIsOperator } from "@/chain/reads";
import { useTxQueue } from "@/chain/TxQueueProvider";
import { authorizeWrite } from "@/chain/writes";
import { REAUTHORIZE_LABEL, reauthorizeNext } from "@/lib/errors";

/**
 * Shown when a join/create failed with ERC7984UnauthorizedSpender: sends setOperator(BluffDice, now + 600 s), then
 * runs `retry` (the original join/create) once.
 */
/**
 * RPC-lag rule: after the authorize receipt (reads are pinned to its block by the TxQueue), wait until the grant
 * is visible at a block >= that receipt before retrying, so a lagging node cannot fail the retry and show
 * "Authorize again" a second time. Gives up after about 10 s and retries anyway.
 */
async function waitForGrant(client: PublicClient | undefined, holder: Address | undefined): Promise<void> {
  if (!client || !holder) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await getIsOperator(client, holder).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

export function AuthorizeAgain({ retry }: { retry: () => Promise<unknown> }) {
  const tx = useTxQueue();
  const client = usePublicClient();
  const { address } = useConnection();
  const [busy, setBusy] = useState(false);
  const [retries, setRetries] = useState(0);
  return (
    <button
      type="button"
      className="button button-primary"
      disabled={busy || tx.busy}
      onClick={() => {
        setBusy(true);
        tx.reset();
        void tx
          .run(authorizeWrite(BigInt(Math.floor(Date.now() / 1000))))
          .then(async (outcome) => {
            // E5-R12: retry the original write once, and only after the authorize succeeded.
            if (reauthorizeNext(outcome.ok, retries) === "retry") {
              setRetries((n) => n + 1);
              await waitForGrant(client, address);
              await retry();
            }
          })
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Check your wallet…" : REAUTHORIZE_LABEL}
    </button>
  );
}
