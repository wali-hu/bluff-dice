// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title BluffChips
/// @author Bluff Dice
/// @notice "Bluff Chips" (BCHIP): the confidential ERC-7984 chip token the game is played with. Balances and
///         transfer amounts are encrypted; anyone can claim free chips from the faucet once a day.
/// @dev Plain OZ `ERC7984` (confidential-contracts 0.5.3): transfers are all-or-nothing (an insufficient balance
///      moves an encrypted 0 instead of reverting), no pause, no denylist, no fees, no upgrade. The game relies on
///      the all-or-nothing rule. Mints use a plaintext amount (trivial encryption), so minted amounts are public
///      by design; only what happens to the chips afterwards stays private.
contract BluffChips is ERC7984, ZamaEthereumConfig, Ownable {
    /// @notice Chips per faucet claim: 1,000 chips (6 decimals).
    uint64 public constant FAUCET_AMOUNT = 1_000 * 10 ** 6;
    /// @notice Time between two faucet claims of the same address.
    uint64 public constant FAUCET_COOLDOWN = 24 hours;

    /// @notice Timestamp of an address's last faucet claim (0 = never claimed).
    mapping(address account => uint64 timestamp) public lastFaucet;

    /// @notice The faucet was used less than `FAUCET_COOLDOWN` ago.
    /// @param nextClaimAt First timestamp at which the caller may claim again.
    error FaucetCooldown(uint64 nextClaimAt);

    /// @notice Deploys the token.
    /// @param initialOwner Account allowed to `mint` (pre-funding demo wallets).
    constructor(address initialOwner) ERC7984("Bluff Chips", "BCHIP", "") Ownable(initialOwner) {}

    /// @notice Mints `FAUCET_AMOUNT` chips to the caller, at most once per `FAUCET_COOLDOWN`.
    /// @dev FHE ops: 1 trivial encrypt + OZ `_mint` (tryIncrease on the supply, select, add on the balance).
    /// @return minted Handle of the minted amount (allowed to the caller).
    function faucet() external returns (euint64 minted) {
        uint64 last = lastFaucet[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        lastFaucet[msg.sender] = uint64(block.timestamp);
        minted = _mint(msg.sender, FHE.asEuint64(FAUCET_AMOUNT));
    }

    /// @notice Owner-only mint, used to pre-fund demo wallets. The amount is public.
    /// @dev FHE ops: same as `faucet`.
    /// @param to Receiver.
    /// @param amount Amount in base units (6 decimals).
    /// @return minted Handle of the minted amount (allowed to `to`).
    function mint(address to, uint64 amount) external onlyOwner returns (euint64 minted) {
        minted = _mint(to, FHE.asEuint64(amount));
    }
}
