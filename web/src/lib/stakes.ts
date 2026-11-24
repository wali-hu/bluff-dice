import { MAX_PLAYERS, MIN_PLAYERS } from "@/config/game";

import { CHIP_DECIMALS } from "./chips";

/** One chip in base units (BluffChips: 6 decimals, FAUCET_AMOUNT = 1_000 * 10 ** 6). */
export const CHIP = 10n ** BigInt(CHIP_DECIMALS);

/** Quick play (owner decision): 2 players, 60 chips. 60 is divisible by 1, 2 and 3, so valid for 2-4 players. */
export const DEFAULT_PLAYERS = 2;
export const DEFAULT_STAKE = 60n * CHIP; // 60_000_000 base units

/** Stakes offered in the create-table form, in whole chips (filtered per player count). */
export const STAKE_PRESETS_CHIPS = [10, 20, 30, 60, 90, 120, 300] as const;

const UINT64_MAX = 2n ** 64n - 1n;

/** Same rule as BluffDice.createTable: stake > 0, divisible by (maxPlayers - 1), stake <= uint64.max / 4. */
export function isValidStake(stake: bigint, maxPlayers: number): boolean {
  if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) return false;
  return stake > 0n && stake % BigInt(maxPlayers - 1) === 0n && stake <= UINT64_MAX / BigInt(MAX_PLAYERS);
}

/** Valid preset stakes (base units) for a player count. */
export function validStakes(maxPlayers: number): bigint[] {
  return STAKE_PRESETS_CHIPS.map((chips) => BigInt(chips) * CHIP).filter((s) => isValidStake(s, maxPlayers));
}

/** Everything at the table: maxPlayers x stake. */
export function potOf(stake: bigint, maxPlayers: number): bigint {
  return stake * BigInt(maxPlayers);
}

/** What each winner receives: (stake / (n - 1)) x n, as in BluffDice._settle. */
export function winnerShare(stake: bigint, maxPlayers: number): bigint {
  return (stake / BigInt(maxPlayers - 1)) * BigInt(maxPlayers);
}

/** The pot sentence of the create-table form: singular for 2 players ("the winner"), plural otherwise. */
export function payoutSentence(stake: bigint, maxPlayers: number, format: (baseUnits: bigint) => string): string {
  const pot = format(potOf(stake, maxPlayers));
  const share = format(winnerShare(stake, maxPlayers));
  const winners = maxPlayers - 1;
  const who = winners === 1 ? "the winner gets" : `each of the ${winners} winners gets`;
  return `Pot ${pot} chips. The loser pays; ${who} ${share} back (stake included).`;
}
