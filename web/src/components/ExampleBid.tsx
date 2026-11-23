"use client";

import { useState } from "react";

import { BoneDie } from "./BoneDie";
import { CipherDie } from "./CipherDie";
import { DiceRow } from "./DiceRow";
import styles from "./ExampleBid.module.css";

const YOUR_DICE = [2, 4, 4, 6, 1] as const;
const THEIR_DICE = [4, 3, 5, 4, 2] as const;
const BID = { quantity: 4, face: 4 } as const;
const THEIR_SEEDS = [7, 19, 31, 43, 67] as const;

const STEPS = [
  {
    title: "The deal",
    text: "Two players, five dice each. You see your own dice; theirs are encrypted.",
  },
  {
    title: "Their bid",
    text: "They bid 4 × fours: at least four of the ten dice on the table show 4.",
  },
  {
    title: "Your call",
    text: "You hold two 4s, so the bid needs two more in their cup. You could raise (4 × fives, 4 × sixes, or 5 of any face). You call Liar.",
  },
  {
    title: "The reveal",
    text: "Four dice show 4. At least four means the bid was true, so the caller (you) loses. The bidder takes the pot.",
  },
] as const;

/** One worked example, stepped by the reader (no autoplay, so it is reduced-motion safe). */
export function ExampleBid() {
  const [step, setStep] = useState(0);
  const current = STEPS[step] ?? STEPS[0];
  const revealed = step === STEPS.length - 1;
  const showBid = step >= 1;
  const called = step >= 2;

  return (
    <section className={styles.example} aria-labelledby="example-title">
      <h2 id="example-title" className={styles.heading}>
        Example round
      </h2>

      <div className={styles.board}>
        <div className={styles.row}>
          <span className={styles.label}>Their cup</span>
          <DiceRow label={revealed ? "Their cup, revealed" : "Their cup: 5 hidden dice"}>
            {THEIR_DICE.map((face, i) =>
              revealed ? (
                <BoneDie key={i} face={face} lit={face === BID.face} />
              ) : (
                <CipherDie key={i} seed={THEIR_SEEDS[i] ?? i} />
              ),
            )}
          </DiceRow>
        </div>

        <div className={styles.bidLine}>
          {showBid ? (
            <>
              <span className={styles.bidChip}>
                Bid: {BID.quantity} × <BoneDie face={BID.face} size="chip" />
              </span>
              {called ? <span className={styles.liar}>LIAR!</span> : null}
            </>
          ) : (
            <span className={styles.waiting}>Waiting for the first bid…</span>
          )}
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Your cup</span>
          <DiceRow label="Your cup">
            {YOUR_DICE.map((face, i) => (
              <BoneDie key={i} face={face} lit={(called || revealed) && face === BID.face} />
            ))}
          </DiceRow>
        </div>
      </div>

      <div className={styles.caption} aria-live="polite">
        <p className={styles.stepCount}>
          Step {step + 1} of {STEPS.length}: {current.title}
        </p>
        <p>{current.text}</p>
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className="button button-ghost"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
        >
          Back
        </button>
        <button type="button" className="button button-primary" onClick={() => setStep((s) => (s + 1) % STEPS.length)}>
          {step === STEPS.length - 1 ? "Start over" : "Next"}
        </button>
      </div>
    </section>
  );
}
