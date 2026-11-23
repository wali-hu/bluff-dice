/**
 * The newest block this tab has seen one of its own transactions mined in. Reads after a receipt must come from
 * a block >= this one (BUILD-LOG Phase D: a load-balanced RPC can answer from an older block right after a
 * receipt). Module state: one value per tab, never decreases.
 */
let pinnedBlock: bigint | undefined;

export function pinReadsTo(blockNumber: bigint): void {
  if (pinnedBlock === undefined || blockNumber > pinnedBlock) pinnedBlock = blockNumber;
}

export function getPinnedBlock(): bigint | undefined {
  return pinnedBlock;
}

/** Tests only. */
export function resetPinnedBlockForTests(): void {
  pinnedBlock = undefined;
}
