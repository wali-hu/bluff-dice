// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @title ReentrantTokenMock
/// @author Bluff Dice
/// @notice Test-only ERC-7984 that, once armed, calls back into a target (the game) from inside a transfer.
///         Proves that the game's `nonReentrant` guard stops a hostile token. Not part of the game.
contract ReentrantTokenMock is ERC7984, ZamaEthereumConfig {
    address private _target;
    bytes private _payload;
    bool private _armed;

    constructor() ERC7984("Reentrant", "REENT", "") {}

    /// @notice Free mint for tests.
    /// @param to Receiver.
    /// @param amount Plaintext amount.
    function mint(address to, uint64 amount) external {
        _mint(to, FHE.asEuint64(amount));
    }

    /// @notice The next game-initiated transfer first calls `target` with `payload`; a revert is bubbled up.
    /// @param target Contract to call back.
    /// @param payload Calldata of the callback.
    function arm(address target, bytes calldata payload) external {
        _target = target;
        _payload = payload;
        _armed = true;
    }

    /// @notice Cancels a pending callback (a reverted transaction leaves the mock armed).
    function disarm() external {
        _armed = false;
    }

    /// @inheritdoc ERC7984
    function confidentialTransfer(address to, euint64 amount) public override returns (euint64) {
        _reenter();
        return super.confidentialTransfer(to, amount);
    }

    /// @inheritdoc ERC7984
    function confidentialTransferFrom(address from, address to, euint64 amount) public override returns (euint64) {
        _reenter();
        return super.confidentialTransferFrom(from, to, amount);
    }

    function _reenter() private {
        if (!_armed) return;
        _armed = false;
        // A hostile token is exactly an arbitrary external call; its revert data is bubbled unchanged so the test
        // sees the game's own error.
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, bytes memory ret) = _target.call(_payload);
        if (!ok) {
            // solhint-disable-next-line no-inline-assembly
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
