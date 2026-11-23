/**
 * The onboarding promise shown on Home ("Play: about N minutes, K transactions + 1 free signature").
 * The single source for these numbers. Values below are the plan's targets, NOT measurements yet: they are
 * replaced by the numbers measured in step E4 (fresh wallet, MetaMask, Sepolia) and `measured` turns true.
 */
export interface PlayEstimate {
  /** Minutes from Home to being seated at a table (rounded up). */
  readonly minutes: number;
  /** Wallet transactions: claim chips, authorize the table, join. */
  readonly transactions: number;
  /** Free EIP-712 signatures (no gas): unlock your dice. */
  readonly freeSignatures: number;
  /** False until the numbers come from the E4 measurement. */
  readonly measured: boolean;
  /** ISO date of the measurement, null while the values are targets. */
  readonly measuredOn: string | null;
}

export const PLAY_ESTIMATE: PlayEstimate = {
  minutes: 2, // target, to be measured in E4
  transactions: 3, // target, to be measured in E4
  freeSignatures: 1, // target, to be measured in E4
  measured: false,
  measuredOn: null,
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "about 2 minutes, 3 transactions + 1 free signature" */
export function formatEstimate(e: PlayEstimate): string {
  return (
    `about ${plural(e.minutes, "minute", "minutes")}, ` +
    `${plural(e.transactions, "transaction", "transactions")} + ` +
    `${plural(e.freeSignatures, "free signature", "free signatures")}`
  );
}
