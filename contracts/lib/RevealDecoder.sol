// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/// @title RevealDecoder
/// @author Bluff Dice
/// @notice Decodes the KMS-signed clear dice of a reveal and counts one face, in plaintext.
/// @dev `cleartexts` is exactly the byte string the KMS signed: one 32-byte big-endian word per handle,
///      in handle order, with NO ABI offset or length words. It is therefore read word by word with
///      calldata slices. `abi.decode(cleartexts, (uint256[]))` would be wrong: a dynamic array encoding
///      starts with an offset word and a length word, which are not part of the signed bytes.
///      Kept as one pure function so the range check can be tested with hand-made words through a
///      harness: a real KMS proof can only carry values the D6 roll produced.
library RevealDecoder {
    /// @notice Highest face of a die.
    uint256 internal constant MAX_FACE = 6;

    /// @notice A decoded die is outside 1..6. Only a bug in the dice code could produce this.
    /// @param index Position of the word in `cleartexts`.
    /// @param value Decoded value.
    error InvalidDieValue(uint256 index, uint256 value);

    /// @notice Counts how many of the first `n` words of `cleartexts` equal `face`.
    /// @dev The caller checks `cleartexts.length == n * 32` before calling. Reverts `InvalidDieValue`
    ///      on the first word outside 1..6. FHE ops: 0.
    /// @param cleartexts Signed clear values, one 32-byte word per die.
    /// @param n Number of dice (words).
    /// @param face Face to count, 1..6.
    /// @return count Number of dice showing `face`.
    function countFace(bytes calldata cleartexts, uint256 n, uint8 face) internal pure returns (uint8 count) {
        for (uint256 i = 0; i < n; ++i) {
            uint256 value = uint256(bytes32(cleartexts[i * 32:(i + 1) * 32]));
            if (value == 0 || value > MAX_FACE) revert InvalidDieValue(i, value);
            if (value == face) ++count;
        }
    }
}
