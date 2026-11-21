// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {D6} from "../lib/D6.sol";

/// @title D6Harness
/// @author Bluff Dice
/// @notice Test-only contract: rolls many dice with the exact production `D6.roll()` so the distribution
///         and the HCU cost of one die can be measured. Not part of the game.
contract D6Harness is ZamaEthereumConfig {
    euint8[] private _dice;

    /// @notice Emitted after each batch.
    /// @param roller Caller, allowed to decrypt the batch.
    /// @param firstIndex Index of the first die of the batch.
    /// @param count Dice rolled.
    event Rolled(address indexed roller, uint256 indexed firstIndex, uint8 count);

    /// @notice Rolls `count` dice; each is allowed to this contract and to the caller.
    /// @dev FHE ops: 6 per die + 2 ACL calls per die; 507,064 HCU per die (20M HCU per tx caps a batch at 39).
    /// @param count Dice to roll in this transaction.
    function rollMany(uint8 count) external {
        uint256 firstIndex = _dice.length;
        for (uint8 i = 0; i < count; ++i) {
            euint8 die = D6.roll();
            FHE.allowThis(die);
            FHE.allow(die, msg.sender);
            _dice.push(die);
        }
        emit Rolled(msg.sender, firstIndex, count);
    }

    /// @notice Number of dice rolled so far.
    /// @return Count.
    function diceCount() external view returns (uint256) {
        return _dice.length;
    }

    /// @notice Handles of the dice in [start, start + count).
    /// @param start First index.
    /// @param count Number of handles.
    /// @return dice Handles.
    function diceRange(uint256 start, uint256 count) external view returns (euint8[] memory dice) {
        dice = new euint8[](count);
        for (uint256 i = 0; i < count; ++i) {
            dice[i] = _dice[start + i];
        }
    }
}
