export const REPO_URL = "https://github.com/wali-hu/bluff-dice";
export const ETHERSCAN_BASE_URL = "https://sepolia.etherscan.io";

export function etherscanAddressUrl(address: string): string {
  return `${ETHERSCAN_BASE_URL}/address/${address}`;
}

export const METAMASK_DOWNLOAD_URL = "https://metamask.io/download/";
