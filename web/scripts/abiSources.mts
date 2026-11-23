/**
 * Where the app's ABIs come from (shared by scripts/sync-abi.mts and the ABI sync unit test).
 * Paths are relative to web/. They exist only in a full checkout with compiled contracts, not on Vercel.
 */
export const ARTIFACTS = {
  bluffDiceAbi: "../artifacts/contracts/BluffDice.sol/BluffDice.json",
  bluffChipsAbi: "../artifacts/contracts/BluffChips.sol/BluffChips.json",
} as const;

/**
 * KMSVerifier errors that can bubble up through `FHE.checkSignatures` in `startGame` / `finalizeReveal`.
 * Read from the installed host contracts artifact (@fhevm/host-contracts 0.10.0, KMSVerifier v0.1.0).
 * Admin-only errors (signer management, upgrades) are left out: our calls cannot reach them.
 */
export const KMS_VERIFIER_ARTIFACT =
  "../node_modules/@fhevm/host-contracts/artifacts/contracts/KMSVerifier.sol/KMSVerifier.json";

export const KMS_VERIFIER_ERRORS = [
  "KMSInvalidSigner",
  "KMSSignatureThresholdNotReached",
  "KMSZeroSignature",
  "EmptyDecryptionProof",
  "DeserializingDecryptionProofFail",
  "ECDSAInvalidSignature",
  "ECDSAInvalidSignatureLength",
  "ECDSAInvalidSignatureS",
] as const;

/**
 * Errors of the Sepolia KMSVerifier v0.4.0 that the installed v0.1.0 artifact does not have. Read from the
 * Etherscan-verified v0.4.0 source in Phase D; `UnsupportedExtraDataVersion` was also observed live
 * (selector 0x2139cc2c, checked by a unit test).
 */
export const KMS_VERIFIER_V040_ERRORS = [
  {
    type: "error",
    name: "UnsupportedExtraDataVersion",
    inputs: [{ name: "version", type: "uint8", internalType: "uint8" }],
  },
  { type: "error", name: "DeserializingExtraDataFail", inputs: [] },
] as const;
