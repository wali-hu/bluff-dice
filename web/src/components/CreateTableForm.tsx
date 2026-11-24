"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { tableIdFromReceipt } from "@/chain/discovery";
import { useTxQueue } from "@/chain/TxQueueProvider";
import { usePlayerReads } from "@/chain/usePlayerReads";
import { createWrite } from "@/chain/writes";
import { MAX_PLAYERS, MIN_PLAYERS } from "@/config/game";
import { formatChips } from "@/lib/chips";
import { hasChips, operatorReady } from "@/lib/onboarding";
import { DEFAULT_STAKE, payoutSentence, validStakes } from "@/lib/stakes";
import { onboardingTimer } from "@/lib/stepTimer";
import { useNow } from "@/lib/useNow";

import styles from "./Lobby.module.css";
import { EncryptedAmountNote } from "@/components/EncryptedAmountNote";

const PLAYER_COUNTS = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i);

/** Create a table: 2-4 seats and only stakes the contract accepts (divisible by seats - 1). */
export function CreateTableForm() {
  const tx = useTxQueue();
  const router = useRouter();
  const queryClient = useQueryClient();
  const reads = usePlayerReads();
  const [players, setPlayers] = useState(2);
  const stakes = validStakes(players);
  const [stake, setStake] = useState<bigint>(DEFAULT_STAKE);
  const chosen = stakes.includes(stake) ? stake : (stakes[0] ?? DEFAULT_STAKE);
  const now = useNow();
  const nowSeconds = BigInt(Math.floor(now / 1000));
  const ready = reads.data ? hasChips(reads.data) && operatorReady({ ...reads.data, nowSeconds }) : false;

  async function create() {
    const outcome = await tx.run(createWrite(chosen, players));
    if (!outcome.ok) return;
    const id = tableIdFromReceipt(outcome.value);
    onboardingTimer.seated();
    void queryClient.invalidateQueries();
    if (id !== undefined) router.push(`/table/${id}`);
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <fieldset className={styles.fieldset}>
        <legend>Players</legend>
        <div className={styles.choices}>
          {PLAYER_COUNTS.map((n) => (
            <label key={n} className={styles.choice}>
              <input type="radio" name="players" value={n} checked={players === n} onChange={() => setPlayers(n)} />
              {n}
            </label>
          ))}
        </div>
      </fieldset>
      <label className={styles.field}>
        Stake per player
        <select value={chosen.toString()} onChange={(e) => setStake(BigInt(e.target.value))}>
          {stakes.map((s) => (
            <option key={s.toString()} value={s.toString()}>
              {formatChips(s)} chips
            </option>
          ))}
        </select>
      </label>
      <p className={styles.muted}>{payoutSentence(chosen, players, formatChips)}</p>
      {ready ? (
        <>
          <button type="submit" className="button button-primary" disabled={tx.busy}>
            Create table
          </button>
          <EncryptedAmountNote />
        </>
      ) : (
        <p className={styles.muted}>
          Claim chips and authorize the table first: <Link href="/play">Play setup</Link>.
        </p>
      )}
    </form>
  );
}
