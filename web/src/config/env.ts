import { resolveRpcUrl } from "./rpc";

export { DEFAULT_SEPOLIA_RPC_URL } from "./rpc";

/** Read RPC (all reads; writes always go through the wallet). Public by design: it ships to the browser. */
export const SEPOLIA_RPC_URL = resolveRpcUrl(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL);

export const SEPOLIA_FAUCET_URL = "https://cloud.google.com/application/web3/faucet/ethereum/sepolia";
