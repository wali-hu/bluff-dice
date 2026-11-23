import { BaseError, decodeErrorResult, type Hex } from "viem";

import { bluffChipsAbi, bluffDiceAbi, kmsVerifierErrorsAbi } from "@/contracts/abi";

/**
 * Every custom error a game transaction can revert with: our two contracts (incl. the OZ ERC-7984,
 * Ownable and ReentrancyGuard errors compiled into them) and the KMSVerifier errors that bubble up through
 * `FHE.checkSignatures`. Deduplicated by name (InvalidKMSSignatures / ZamaProtocolUnsupported are in both).
 */
type ErrorItem = Extract<
  (typeof bluffDiceAbi | typeof bluffChipsAbi | typeof kmsVerifierErrorsAbi)[number],
  { type: "error" }
>;
export type ContractErrorName = ErrorItem["name"];

function errorsOf(abi: readonly { type: string }[]): ErrorItem[] {
  return abi.filter((item): item is ErrorItem => item.type === "error");
}

export const combinedErrorsAbi: readonly ErrorItem[] = (() => {
  const byName = new Map<string, ErrorItem>();
  for (const item of [...errorsOf(bluffDiceAbi), ...errorsOf(bluffChipsAbi), ...errorsOf(kmsVerifierErrorsAbi)]) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  return [...byName.values()];
})();

/** How the UI reacts: show a message, or refresh state silently (the table moved on, nothing to explain). */
export type ErrorPresentation = { readonly silent: boolean; readonly message: string };

type Args = readonly unknown[];
type Describe = (args: Args, ctx: DescribeContext) => ErrorPresentation;

export interface DescribeContext {
  /** Formats a unix time in seconds as a local clock time (injectable for tests). */
  readonly formatTime: (unixSeconds: bigint) => string;
}

export const defaultDescribeContext: DescribeContext = {
  formatTime: (unixSeconds) =>
    new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      new Date(Number(unixSeconds) * 1000),
    ),
};

const show = (message: string): ErrorPresentation => ({ silent: false, message });
const refresh = (message: string): ErrorPresentation => ({ silent: true, message });

const PROOF_RETRY = "The decryption proof was rejected onchain. Fetch a fresh proof and push again.";
const INTERNAL = "The contract refused an internal state it should never reach. Please report this table.";
const DEPLOY_ONLY = "Contract configuration error (only possible at deployment).";

/**
 * Text for every error. Typed as a Record over ContractErrorName, so the build fails when the ABI gains an
 * error without a message (the unit test checks the same at runtime).
 */
export const ERROR_MESSAGES: Record<ContractErrorName, Describe> = {
  // BluffDice
  AlreadySeated: () => show("You already have a seat at this table."),
  BidNotHigher: ([prevQ, prevF]) =>
    show(`Your bid must beat ${String(prevQ)} × ${String(prevF)}: more dice, or the same number with a higher face.`),
  DeadlineNotPassed: ([, deadline], { formatTime }) =>
    show(`Not yet. This becomes possible after ${formatTime(deadline as bigint)}.`),
  DieNotInitialized: () => show(INTERNAL),
  DroppedFromTable: () =>
    show(
      "Your stake did not arrive (not enough chips), so this table removed you. Claim chips and join another table.",
    ),
  DuplicatePaidHandle: () =>
    show("Two wallets without chips joined in the same block. Claim chips first, then join again."),
  InvalidBidTimeout: () => show(DEPLOY_ONLY),
  InvalidCleartextsLength: () => show(PROOF_RETRY),
  InvalidDieValue: () => show(PROOF_RETRY),
  InvalidFace: () => show("Pick a face from 1 to 6."),
  InvalidKMSSignatures: () => show(PROOF_RETRY),
  InvalidMaxPlayers: () => show("A table has 2 to 4 seats."),
  InvalidPaidFlag: () => show(PROOF_RETRY),
  InvalidQuantity: ([, max]) => show(`The number of dice must be from 1 to ${String(max)}.`),
  InvalidStake: ([, maxPlayers]) =>
    show(`The stake must split evenly between ${Number(maxPlayers) - 1} winners. Pick one of the offered stakes.`),
  InvalidToken: () => show(DEPLOY_ONLY),
  LiarNotCalled: () => refresh("Nobody has called Liar at this table yet."),
  NoBidToChallenge: () => show("There is no bid to call Liar on yet. Open with a bid."),
  NotCancellable: () => refresh("This table cannot be cancelled any more: it already moved on."),
  NotPlayer: () => show("You are not seated at this table."),
  NotYourTurn: () => show("It is not your turn."),
  PaidCheckNotRequested: () => refresh("The stake check has not started yet. Refreshing the table."),
  PaidFlagNotInitialized: () => show(INTERNAL),
  ReentrancyGuardReentrantCall: () => show(INTERNAL),
  TableNotFound: () => show("This table does not exist."),
  TurnExpired: () => show("Too late: the turn time ran out. Anyone can now claim the timeout."),
  WrongPhase: () => refresh("The table already moved on. Refreshing."),
  ZamaProtocolUnsupported: () => show(DEPLOY_ONLY),
  // BluffChips (OZ ERC-7984 0.5.3, Ownable, FHE library)
  ERC7984InvalidReceiver: () => show("Invalid receiver address."),
  ERC7984InvalidSender: () => show("Invalid sender address."),
  ERC7984UnauthorizedCaller: () => show("This account may not move these chips."),
  ERC7984UnauthorizedSpender: () =>
    show("Your table authorization expired. Authorize the table again (one transaction), then retry."),
  ERC7984UnauthorizedUseOfEncryptedAmount: () => show("An encrypted amount was used without permission."),
  ERC7984UtilsUnauthorizedUseOfEncryptedAmount: () => show("An encrypted amount was used without permission."),
  FaucetCooldown: ([nextClaimAt], { formatTime }) => show(`Next free chips at ${formatTime(nextClaimAt as bigint)}.`),
  OwnableInvalidOwner: () => show("Only the chip token owner can do this."),
  OwnableUnauthorizedAccount: () => show("Only the chip token owner can do this."),
  SenderNotAllowedToUseHandle: () => show("This encrypted value is not yours to use."),
  // KMSVerifier (through FHE.checkSignatures)
  KMSInvalidSigner: () => show(PROOF_RETRY),
  KMSSignatureThresholdNotReached: () => show(PROOF_RETRY),
  KMSZeroSignature: () => show(PROOF_RETRY),
  EmptyDecryptionProof: () => show(PROOF_RETRY),
  DeserializingDecryptionProofFail: () => show(PROOF_RETRY),
  ECDSAInvalidSignature: () => show(PROOF_RETRY),
  ECDSAInvalidSignatureLength: () => show(PROOF_RETRY),
  ECDSAInvalidSignatureS: () => show(PROOF_RETRY),
  UnsupportedExtraDataVersion: () => show(PROOF_RETRY),
  DeserializingExtraDataFail: () => show(PROOF_RETRY),
};

/** Everything the transaction queue can end with, in words. */
export type TxError =
  | { kind: "contract"; name: ContractErrorName; args: Args; silent: boolean; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "inFlightLimit"; message: string }
  | { kind: "insufficientFunds"; message: string }
  | { kind: "revertedOnchain"; message: string }
  | { kind: "unknown"; message: string; detail: string };

/** Sepolia + EIP-7702 delegated accounts: only one pending transaction (BUILD-LOG Phase D). */
const IN_FLIGHT_RE = /in-flight transaction limit/i;

export function describeContractError(
  name: ContractErrorName,
  args: Args,
  ctx: DescribeContext = defaultDescribeContext,
): TxError {
  const { silent, message } = ERROR_MESSAGES[name](args, ctx);
  return { kind: "contract", name, args, silent, message };
}

/** Decodes raw revert data against the combined ABI; null when the selector is unknown. */
export function decodeRevertData(data: Hex, ctx: DescribeContext = defaultDescribeContext): TxError | null {
  try {
    const decoded = decodeErrorResult({ abi: combinedErrorsAbi, data });
    return describeContractError(decoded.errorName as ContractErrorName, decoded.args ?? [], ctx);
  } catch {
    return null;
  }
}

function findRevertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  let found: Hex | undefined;
  error.walk((inner) => {
    const candidate = (inner as { data?: unknown; raw?: unknown }).raw ?? (inner as { data?: unknown }).data;
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) {
      found = candidate as Hex;
      return true;
    }
    return false;
  });
  return found;
}

function hasCode(error: unknown, code: number): boolean {
  if (!(error instanceof BaseError)) return false;
  return Boolean(error.walk((inner) => (inner as { code?: unknown }).code === code));
}

/** Turns anything thrown by simulate / estimate / wallet / receipt into a TxError with a message. */
export function toTxError(error: unknown, ctx: DescribeContext = defaultDescribeContext): TxError {
  const text = error instanceof Error ? `${error.message} ${(error as BaseError).details ?? ""}` : String(error);

  const data = findRevertData(error);
  if (data) {
    const decoded = decodeRevertData(data, ctx);
    if (decoded) return decoded;
  }
  if (hasCode(error, 4001) || /user (rejected|denied)/i.test(text)) {
    return { kind: "rejected", message: "You cancelled in the wallet. Nothing was sent." };
  }
  if (IN_FLIGHT_RE.test(text)) {
    return {
      kind: "inFlightLimit",
      message:
        "Your wallet already has a pending transaction (smart accounts allow only one). Finish or cancel it in your wallet, then continue.",
    };
  }
  if (/insufficient funds/i.test(text)) {
    return { kind: "insufficientFunds", message: "Not enough Sepolia ETH to pay for gas. Get some from a faucet." };
  }
  return {
    kind: "unknown",
    message: "The transaction could not be sent. Check your connection and try again.",
    detail: text.slice(0, 500),
  };
}
