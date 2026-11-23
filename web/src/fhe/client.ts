import type { Address, Hex } from "viem";

import type { WalletTypedData } from "./eip712";

/** Signs the user-decrypt permit with the connected wallet (wagmi `signTypedData`). */
export type TypedDataSigner = (typedData: WalletTypedData) => Promise<Hex>;

export interface DecryptItem {
  readonly handle: Hex;
  /** The contract the handle belongs to (BluffDice for dice, BluffChips for balances). */
  readonly contract: Address;
}

export interface UserDecryptOptions {
  /**
   * Own dice right after GameStarted: first wait until ACL.persistAllowed(die, me) is true at a block >= this one,
   * then retry the SDK's pre-check refusal / "not ready" with backoff for up to 60 s (RPC lag).
   */
  readonly ownDiceAfterBlock?: bigint;
  /** Words for <RelayerStatus/>, e.g. "Decrypting your chips". */
  readonly label?: string;
}

export interface UnlockOptions {
  /** The wallet's current chain; anything but Sepolia is refused before a signature is asked. */
  readonly walletChainId?: number;
}

export interface PublicDecryptResult {
  readonly clear: Map<Hex, bigint>;
  /** `abiEncodedClearValues`, byte for byte as returned: pass unchanged to the contract. */
  readonly abiEncoded: Hex;
  /** `decryptionProof`, byte for byte as returned. */
  readonly proof: Hex;
}

/** Raw relayer exchange of the "Try to peek" demo (S6, step E7). */
export interface RelayerRawResult {
  readonly request: unknown;
  readonly responses: readonly { readonly status: number; readonly body: unknown }[];
}

/** The only FHE surface the app uses; the SDK stays behind it (web/src/fhe/). */
export interface FheClient {
  /** WASM, public key, CRS; idempotent; cached promise. */
  init(): Promise<void>;
  /** Keypair + EIP-712 for [BluffDice, BluffChips], 1 day; kept in memory only. */
  unlock(user: Address, sign: TypedDataSigner, options?: UnlockOptions): Promise<void>;
  /** Zero handles (`bytes32(0)`: not dealt / never funded) are skipped and absent from the result. */
  userDecrypt(items: readonly DecryptItem[], options?: UserDecryptOptions): Promise<Map<Hex, bigint>>;
  publicDecrypt(handles: readonly Hex[]): Promise<PublicDecryptResult>;
  rawUserDecryptForDemo(handle: Hex, contract: Address): Promise<RelayerRawResult>;
  /** Drops keypair + signature. */
  lock(): void;
}
