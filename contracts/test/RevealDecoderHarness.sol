// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {RevealDecoder} from "../lib/RevealDecoder.sol";

/// @title RevealDecoderHarness
/// @author Bluff Dice
/// @notice Test-only contract: exposes the exact production `RevealDecoder.countFace` so the decoder can be
///         fed hand-made words (0, 7, high bytes set) that a real KMS proof can never carry. Not part of the game.
contract RevealDecoderHarness {
    /// @notice See `RevealDecoder.countFace`.
    /// @param cleartexts One 32-byte word per die.
    /// @param n Number of words to read.
    /// @param face Face to count.
    /// @return Number of words equal to `face`.
    function countFace(bytes calldata cleartexts, uint256 n, uint8 face) external pure returns (uint8) {
        return RevealDecoder.countFace(cleartexts, n, face);
    }
}
