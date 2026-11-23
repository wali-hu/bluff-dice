import { BLUFF_CHIPS_ADDRESS, BLUFF_DICE_ADDRESS } from "@/contracts/addresses";
import { etherscanAddressUrl, REPO_URL } from "@/config/links";
import { DISCLAIMER } from "@/lib/disclaimer";

import styles from "./Disclaimer.module.css";

/** Site footer with the required disclaimer (every screen) and the public contract + source links. */
export function Disclaimer() {
  return (
    <footer className={styles.footer}>
      <div className="container">
        <p className={styles.disclaimer}>{DISCLAIMER}</p>
        <ul className={styles.links}>
          <li>
            <a href={etherscanAddressUrl(BLUFF_DICE_ADDRESS)} target="_blank" rel="noopener noreferrer">
              BluffDice on Etherscan
            </a>
          </li>
          <li>
            <a href={etherscanAddressUrl(BLUFF_CHIPS_ADDRESS)} target="_blank" rel="noopener noreferrer">
              BluffChips on Etherscan
            </a>
          </li>
          <li>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              Source on GitHub
            </a>
          </li>
        </ul>
        <p className={styles.network}>Runs on the Ethereum Sepolia testnet. Chips have no value.</p>
      </div>
    </footer>
  );
}
