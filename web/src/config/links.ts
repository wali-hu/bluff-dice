export const REPO_URL = "https://github.com/wali-hu/liars-dice-kit";
export const ETHERSCAN_BASE_URL = "https://sepolia.etherscan.io";

export function etherscanAddressUrl(address: string): string {
  return `${ETHERSCAN_BASE_URL}/address/${address}`;
}
