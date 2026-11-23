"use client";

import { useFheClient, useFheStatus, useInitTiming } from "@/fhe/FheProvider";
import type { InitPhase } from "@/fhe/timing";

import styles from "./FheInitPanel.module.css";
import { RelayerStatus } from "./RelayerStatus";

const PHASES: readonly { phase: InitPhase; label: string }[] = [
  { phase: "script", label: "SDK script" },
  { phase: "wasm", label: "WASM (download, sha256 check, compile)" },
  { phase: "keys", label: "Public key + CRS (download, sha256 check)" },
  { phase: "createInstance", label: "createInstance (chain checks)" },
];

function s(ms: number | undefined): string {
  return ms === undefined ? "…" : `${(ms / 1000).toFixed(1)} s`;
}

/** Shows the background load of the encryption toolkit and its timing (for measuring cold starts). */
export function FheInitPanel() {
  const client = useFheClient();
  const status = useFheStatus("init");
  const timing = useInitTiming();
  return (
    <section className={styles.card} aria-labelledby="fhe-init-title">
      <h2 id="fhe-init-title" className={styles.title}>
        Encryption toolkit
      </h2>
      <p className={styles.lead}>
        Loads in the background from this site (about 10.8 MB the first time, every file checked against a pinned
        sha256). It is needed to read your dice.
      </p>
      {status.phase === "ok" && timing.total !== undefined ? (
        <p className={styles.ready} data-testid="fhe-ready">
          Encryption toolkit ready in <span className="mono">{s(timing.total)}</span>
        </p>
      ) : (
        <RelayerStatus
          channel="init"
          idleText="Waiting to start (after the page has loaded)…"
          hint="first visit up to about a minute"
          onRetry={() => void client.init().catch(() => undefined)}
        />
      )}
      <dl className={styles.timing}>
        {PHASES.map(({ phase, label }) => (
          <div key={phase} className={styles.row}>
            <dt>{label}</dt>
            <dd className="mono" data-testid={`fhe-${phase}`}>
              {s(timing[phase])}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
