/** BluffChips has 6 decimals (OZ ERC-7984 default). */
export const CHIP_DECIMALS = 6;

/** 1_000_000_000n -> "1,000"; 1_500_000n -> "1.5". Exact (bigint), en-US grouping. */
export function formatChips(baseUnits: bigint): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const unit = 10n ** BigInt(CHIP_DECIMALS);
  const whole = (abs / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % unit).toString().padStart(CHIP_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
