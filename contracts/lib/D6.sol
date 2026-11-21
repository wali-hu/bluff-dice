// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint8, euint64} from "@fhevm/solidity/lib/FHE.sol";

/// @title D6
/// @author Bluff Dice
/// @notice Rolls one encrypted six-sided die (value 1..6) from onchain FHE randomness.
/// @dev Method: multiply-shift on 32 random bits (Lemire, arXiv 1805.10941).
///      die = ((r32 * 6) >> 32) + 1, computed in euint64 so r32 * 6 cannot overflow.
///      A perfectly fair d6 from random bits is impossible (1/6 is not k / 2^n). With 2^32 inputs,
///      four faces get 715,827,883 inputs and two faces get 715,827,882: every face is within
///      1.6e-10 of 1/6. The FHE ops only accept power-of-two bounds, which is why the die is not
///      drawn with a bounded `randEuint8(6)`.
///      Cost: 6 FHE ops, 507,064 HCU, HCU depth 507,064
///      (rand32 24,000 + cast 32 + mul64 scalar 365,000 + shr64 scalar 34,000 + cast 32 + add8 scalar 84,000).
library D6 {
    /// @notice Rolls one die.
    /// @dev The result is only transiently allowed to the calling contract. The caller MUST call
    ///      `FHE.allowThis` (and `FHE.allow` for the owner) before storing it.
    ///      Randomness only works inside a transaction, never in an `eth_call`.
    /// @return die Encrypted die value in 1..6.
    function roll() internal returns (euint8 die) {
        euint64 wide = FHE.asEuint64(FHE.randEuint32());
        euint64 scaled = FHE.shr(FHE.mul(wide, uint64(6)), uint8(32));
        die = FHE.add(FHE.asEuint8(scaled), uint8(1));
    }
}
