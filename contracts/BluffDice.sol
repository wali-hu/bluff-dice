// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {D6} from "./lib/D6.sol";
import {RevealDecoder} from "./lib/RevealDecoder.sol";

/// @title BluffDice
/// @author Bluff Dice
/// @notice Confidential Liar's Dice. Every die is rolled onchain with FHE randomness and stays encrypted:
///         only its owner can decrypt it. Bids are public. "Liar" makes every die of the round publicly
///         decryptable; anyone then submits the clear dice with the KMS proof, and the contract counts the
///         bid face in plaintext. The KMS proof is the only authority; handles always come from storage.
/// @dev One contract holds every table in a mapping (no clones: `ZamaEthereumConfig` configures the
///      coprocessor in the constructor, which a minimal proxy would skip).
///      The `Table` layout is final: fields used by later phases (reveal, stakes, pot) are declared now.
///      Nothing in this contract branches on an encrypted value, so gas never depends on a secret.
contract BluffDice is ZamaEthereumConfig {
    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    /// @notice Maximum players per table.
    uint8 public constant MAX_PLAYERS = 4;
    /// @notice Minimum players per table.
    uint8 public constant MIN_PLAYERS = 2;
    /// @notice Dice per player.
    uint8 public constant DICE_PER_PLAYER = 5;
    /// @notice Number of faces of a die.
    uint8 public constant FACES = 6;
    /// @notice Time allowed for a decryption proof to arrive before anyone may `cancel`
    ///         (reveal proof; from Phase C on also the paid-flag proof).
    uint64 public constant PROOF_TIMEOUT = 1 hours;
    /// @notice Sentinel for "no seat".
    uint8 public constant NO_SEAT = type(uint8).max;

    /// @notice Time the player on turn has to act before anyone can claim the timeout.
    uint64 public immutable BID_TIMEOUT;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Table lifecycle. `AwaitingPaidProof` is unused until stakes exist (Phase C):
    ///         until then a full table goes from `Joining` straight to `Bidding`.
    enum Phase {
        None,
        Joining,
        AwaitingPaidProof,
        Bidding,
        AwaitingReveal,
        Settled,
        Cancelled
    }

    /// @notice Full state of one table.
    /// @dev Seats are filled "first empty seat" so a seat can reopen (leave, or a dropped non-payer).
    ///      Dice are indexed by seat; the reveal handle order is seat 0..3, then die 0..4.
    struct Table {
        Phase phase;
        uint8 maxPlayers;
        uint8 playerCount;
        uint8 turnSeat; // seat to act while Bidding, NO_SEAT otherwise
        uint8 bidQuantity; // 0 = no bid yet
        uint8 bidFace; // 1..6
        uint8 bidderSeat; // NO_SEAT until the first bid
        uint8 liarCallerSeat; // NO_SEAT until "Liar" is called
        uint8 loserSeat; // NO_SEAT until settled
        uint8 revealedCount; // plaintext count of the bid face, set by finalizeReveal
        uint32 round; // 0 before the start, 1 in v1; NOT part of the reveal replay guard (see finalizeReveal)
        uint64 deadline; // turn deadline while Bidding, proof deadline while Awaiting*
        uint64 stake; // public, fixed per table (pulled from Phase C on)
        address[MAX_PLAYERS] players; // seat -> player, address(0) = empty seat
        euint8[DICE_PER_PLAYER][MAX_PLAYERS] dice; // seat -> encrypted dice (owner-only ACL)
        euint64[MAX_PLAYERS] transferred; // Phase C: amount actually pulled at join
        ebool[MAX_PLAYERS] paid; // Phase C: transferred == stake
        euint64 pot; // Phase C: sum of transferred
    }

    /// @notice Public view of a table (everything except ciphertext handles).
    struct TableView {
        Phase phase;
        uint8 maxPlayers;
        uint8 playerCount;
        uint8 turnSeat;
        uint8 bidQuantity;
        uint8 bidFace;
        uint8 bidderSeat;
        uint8 liarCallerSeat;
        uint8 loserSeat;
        uint8 revealedCount;
        uint32 round;
        uint64 deadline;
        uint64 stake;
        address[MAX_PLAYERS] players;
    }

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    mapping(uint256 tableId => Table table) internal _tables;

    /// @notice Id the next created table gets. Starts at 1, so table id 0 never exists.
    uint256 public nextTableId = 1;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    /// @notice A table was created.
    /// @param tableId Table id.
    /// @param creator Creator, seated at seat 0.
    /// @param stake Public stake per player.
    /// @param maxPlayers Seats at the table.
    event TableCreated(uint256 indexed tableId, address indexed creator, uint64 stake, uint8 maxPlayers);

    /// @notice A player took a seat.
    /// @param tableId Table id.
    /// @param player Player address.
    /// @param seat Seat index.
    event PlayerJoined(uint256 indexed tableId, address indexed player, uint8 seat);

    /// @notice A player left a table before the game started.
    /// @param tableId Table id.
    /// @param player Player address.
    /// @param seat Seat that reopened.
    event PlayerLeft(uint256 indexed tableId, address indexed player, uint8 seat);

    /// @notice A table was cancelled.
    /// @param tableId Table id.
    event TableCancelled(uint256 indexed tableId);

    /// @notice The table filled up and every player got their encrypted dice.
    /// @param tableId Table id.
    /// @param round Round number.
    /// @param firstSeat Seat that bids first.
    /// @param deadline Deadline of the first turn.
    event GameStarted(uint256 indexed tableId, uint32 indexed round, uint8 firstSeat, uint64 deadline);

    /// @notice A public bid "at least `quantity` dice show `face`".
    /// @param tableId Table id.
    /// @param round Round number.
    /// @param bidder Player who bid.
    /// @param quantity Bid quantity.
    /// @param face Bid face.
    /// @param nextSeat Seat now on turn.
    /// @param deadline Deadline of the next turn.
    event BidPlaced(
        uint256 indexed tableId,
        uint32 indexed round,
        address indexed bidder,
        uint8 quantity,
        uint8 face,
        uint8 nextSeat,
        uint64 deadline
    );

    /// @notice The player on turn did not act in time and lost the round.
    /// @param tableId Table id.
    /// @param round Round number.
    /// @param loser Player who timed out.
    event TurnTimedOut(uint256 indexed tableId, uint32 indexed round, address indexed loser);

    /// @notice The player on turn called "Liar" on the current bid. Every die of the round is now
    ///         publicly decryptable (forever).
    /// @param tableId Table id.
    /// @param round Round number.
    /// @param caller Player who called "Liar".
    /// @param bidder Player whose bid is challenged.
    /// @param quantity Challenged bid quantity.
    /// @param face Challenged bid face.
    /// @param revealDeadline After this time anyone may `cancel` if no proof was submitted.
    event LiarCalled(
        uint256 indexed tableId,
        uint32 indexed round,
        address indexed caller,
        address bidder,
        uint8 quantity,
        uint8 face,
        uint64 revealDeadline
    );

    /// @notice The reveal proof was verified and the round is decided. The clear dice are in the
    ///         `PublicDecryptionVerified(handles, cleartexts)` event of the same transaction.
    /// @param tableId Table id.
    /// @param round Round number.
    /// @param loser Losing player: the caller if `count >= quantity`, else the bidder.
    /// @param count Dice showing `face`.
    /// @param quantity Challenged bid quantity.
    /// @param face Challenged bid face.
    event RoundRevealed(
        uint256 indexed tableId,
        uint32 indexed round,
        address indexed loser,
        uint8 count,
        uint8 quantity,
        uint8 face
    );

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice The bid timeout given to the constructor is zero.
    error InvalidBidTimeout();
    /// @notice Stake is zero or not divisible by `maxPlayers - 1` (the pot split would leave dust).
    error InvalidStake(uint64 stake, uint8 maxPlayers);
    /// @notice `maxPlayers` is outside 2..4.
    error InvalidMaxPlayers(uint8 maxPlayers);
    /// @notice No table with this id.
    error TableNotFound(uint256 tableId);
    /// @notice The table is not in the phase this action needs.
    error WrongPhase(uint256 tableId, Phase expected, Phase actual);
    /// @notice The caller already has a seat at this table.
    error AlreadySeated(uint256 tableId, address player);
    /// @notice The account has no seat at this table.
    error NotPlayer(uint256 tableId, address account);
    /// @notice It is another player's turn.
    error NotYourTurn(uint256 tableId, address expected, address caller);
    /// @notice The turn deadline has passed; only `claimTurnTimeout` is possible now.
    error TurnExpired(uint256 tableId, uint64 deadline);
    /// @notice The turn deadline has not passed yet.
    error DeadlineNotPassed(uint256 tableId, uint64 deadline);
    /// @notice Bid face outside 1..6.
    error InvalidFace(uint8 face);
    /// @notice Bid quantity is zero or larger than the number of dice in play.
    error InvalidQuantity(uint8 quantity, uint8 maxQuantity);
    /// @notice The bid does not raise the previous bid.
    error BidNotHigher(uint8 prevQuantity, uint8 prevFace, uint8 quantity, uint8 face);
    /// @notice "Liar" needs a bid to challenge.
    error NoBidToChallenge(uint256 tableId);
    /// @notice A die handle is empty. Invariant guard: never reveal an uninitialized handle.
    error DieNotInitialized(uint8 seat, uint8 index);
    /// @notice Nobody called "Liar" on this table, so its dice are not public.
    error LiarNotCalled(uint256 tableId);
    /// @notice `cleartexts` is not exactly one 32-byte word per die handle.
    error InvalidCleartextsLength(uint256 expected, uint256 actual);
    /// @notice The table cannot be cancelled in this phase.
    error NotCancellable(uint256 tableId, Phase phase);

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @notice Deploys the game.
    /// @param bidTimeout Seconds the player on turn has to act (deploy default: 300 = 5 minutes).
    constructor(uint64 bidTimeout) {
        if (bidTimeout == 0) revert InvalidBidTimeout();
        BID_TIMEOUT = bidTimeout;
    }

    // ---------------------------------------------------------------------------------------------
    // Table lifecycle
    // ---------------------------------------------------------------------------------------------

    /// @notice Creates a table and seats the caller at seat 0.
    /// @dev FHE ops: 0.
    /// @param stake Public stake per player; must be divisible by `maxPlayers - 1`.
    /// @param maxPlayers Seats at the table (2..4). The game starts when all seats are taken.
    /// @return tableId Id of the new table.
    function createTable(uint64 stake, uint8 maxPlayers) external returns (uint256 tableId) {
        if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) revert InvalidMaxPlayers(maxPlayers);
        if (stake == 0 || stake % (maxPlayers - 1) != 0) revert InvalidStake(stake, maxPlayers);

        tableId = nextTableId;
        ++nextTableId;
        Table storage t = _tables[tableId];
        t.phase = Phase.Joining;
        t.maxPlayers = maxPlayers;
        t.stake = stake;
        t.turnSeat = NO_SEAT;
        t.bidderSeat = NO_SEAT;
        t.liarCallerSeat = NO_SEAT;
        t.loserSeat = NO_SEAT;

        emit TableCreated(tableId, msg.sender, stake, maxPlayers);
        _seat(tableId, t, msg.sender);
    }

    /// @notice Takes a seat. The join that fills the table rolls every player's dice.
    /// @dev FHE ops: 0 for a normal join. The filling join runs `_startGame`:
    ///      6 FHE ops + 2 ACL calls per die, i.e. 30 FHE ops per player
    ///      (4 players: 120 FHE ops, 40 ACL calls, 20 new handles, 10,141,280 HCU, depth 507,064).
    /// @param tableId Table to join.
    function joinTable(uint256 tableId) external {
        Table storage t = _tableInPhase(tableId, Phase.Joining);
        if (_seatOf(t, msg.sender) != NO_SEAT) revert AlreadySeated(tableId, msg.sender);

        _seat(tableId, t, msg.sender);
        if (t.playerCount == t.maxPlayers) _startGame(tableId, t);
    }

    /// @notice Leaves a table that has not started. The seat reopens; the last leaver cancels the table.
    /// @dev Only while Joining: once dice are rolled nobody may leave (no selective abort after
    ///      seeing your dice). Phase C refunds the seat's stake here. FHE ops: 0.
    /// @param tableId Table to leave.
    function leaveTable(uint256 tableId) external {
        Table storage t = _tableInPhase(tableId, Phase.Joining);
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == NO_SEAT) revert NotPlayer(tableId, msg.sender);

        t.players[seat] = address(0);
        --t.playerCount;
        emit PlayerLeft(tableId, msg.sender, seat);

        if (t.playerCount == 0) {
            t.phase = Phase.Cancelled;
            emit TableCancelled(tableId);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Bidding
    // ---------------------------------------------------------------------------------------------

    /// @notice Public bid: "at least `quantity` dice on the table show `face`".
    /// @dev Must raise the previous bid: higher quantity, or same quantity and higher face.
    ///      Reverts after the turn deadline so the timeout outcome is deterministic. FHE ops: 0.
    /// @param tableId Table id.
    /// @param quantity Bid quantity, 1..(players * 5).
    /// @param face Bid face, 1..6.
    function bid(uint256 tableId, uint8 quantity, uint8 face) external {
        Table storage t = _tableInPhase(tableId, Phase.Bidding);
        _requireTurn(tableId, t);
        if (block.timestamp > t.deadline) revert TurnExpired(tableId, t.deadline);
        _validateBid(t, quantity, face);

        uint64 deadline = uint64(block.timestamp) + BID_TIMEOUT;
        uint8 nextSeat = (t.turnSeat + 1) % t.maxPlayers;
        t.bidQuantity = quantity;
        t.bidFace = face;
        t.bidderSeat = t.turnSeat;
        t.turnSeat = nextSeat;
        t.deadline = deadline;

        emit BidPlaced(tableId, t.round, msg.sender, quantity, face, nextSeat, deadline);
    }

    /// @notice Anyone can end a round whose player on turn did not act in time; that player loses.
    /// @dev The dice are NOT revealed: a timeout never makes anything publicly decryptable. FHE ops: 0.
    /// @param tableId Table id.
    function claimTurnTimeout(uint256 tableId) external {
        Table storage t = _tableInPhase(tableId, Phase.Bidding);
        if (block.timestamp <= t.deadline) revert DeadlineNotPassed(tableId, t.deadline);

        uint8 loser = t.turnSeat;
        t.phase = Phase.Settled;
        _settle(t, loser);

        emit TurnTimedOut(tableId, t.round, t.players[loser]);
    }

    // ---------------------------------------------------------------------------------------------
    // Liar and reveal
    // ---------------------------------------------------------------------------------------------

    /// @notice The player on turn challenges the current bid. Every die at the table becomes publicly
    ///         decryptable, forever; anyone can then fetch the clear dice and the KMS proof off-chain and
    ///         call `finalizeReveal`.
    /// @dev Allowed up to and including the turn deadline (same rule as `bid`), so it never overlaps with
    ///      `claimTurnTimeout`. FHE ops: 0 (no encrypted count, no ebool). HCU: 0.
    ///      ACL calls: maxPlayers * 5 `makePubliclyDecryptable` (4 players: 20).
    ///      Gas (mock, gasUsed): 2 players 361,360; 3 players 519,825; 4 players 678,291 (about 31,700 per die);
    ///      x3.2 Sepolia estimate for 4 players: 2.17M, 13% of the 16,777,216 per-tx cap.
    /// @param tableId Table id.
    function callLiar(uint256 tableId) external {
        Table storage t = _tableInPhase(tableId, Phase.Bidding);
        _requireTurn(tableId, t);
        if (block.timestamp > t.deadline) revert TurnExpired(tableId, t.deadline);
        if (t.bidQuantity == 0) revert NoBidToChallenge(tableId);

        uint64 revealDeadline = uint64(block.timestamp) + PROOF_TIMEOUT;
        t.liarCallerSeat = t.turnSeat;
        t.turnSeat = NO_SEAT;
        t.deadline = revealDeadline;
        t.phase = Phase.AwaitingReveal;

        for (uint8 seat = 0; seat < t.maxPlayers; ++seat) {
            for (uint8 i = 0; i < DICE_PER_PLAYER; ++i) {
                euint8 die = t.dice[seat][i];
                if (!FHE.isInitialized(die)) revert DieNotInitialized(seat, i);
                FHE.makePubliclyDecryptable(die);
            }
        }

        emit LiarCalled(
            tableId,
            t.round,
            msg.sender,
            t.players[t.bidderSeat],
            t.bidQuantity,
            t.bidFace,
            revealDeadline
        );
    }

    /// @notice Settles a challenged round from the publicly decrypted dice. Permissionless: the KMS proof
    ///         is the authority, not the caller.
    /// @dev Steps: (1) phase must be AwaitingReveal; (2) the handle list is rebuilt from STORAGE (same
    ///      order as `revealHandles`), never taken from calldata; (3) exactly one 32-byte word per handle;
    ///      (4) phase = Settled before any external call; (5) `FHE.checkSignatures` reverts on any
    ///      wrong value, order, handle or signature and emits `PublicDecryptionVerified`; (6) words are
    ///      decoded one by one, each must be 1..6; (7) count >= quantity -> the caller loses (a tie means
    ///      the bid was true), otherwise the bidder loses.
    ///      Replay protection: the phase guard alone. Table ids are unique, Settled and Cancelled are final,
    ///      and the handles come from storage. A proof is bound to its round by the handles (every roll
    ///      creates fresh handles), not by `round`. Invariant for any future multi-round mode: every round
    ///      must re-roll every die and reset `liarCallerSeat`, otherwise an old proof becomes valid again.
    ///      Accepted after the proof deadline too, until someone calls `cancel`.
    ///      FHE ops: 0. HCU: 0. One `checkSignatures` (KMS signature verification).
    ///      Gas (mock, 1 KMS signature, LOWER BOUND; Sepolia proofs carry more signatures):
    ///      about 136k (2 players), 156k (3), 177k (4); varies by a few hundred gas with the calldata bytes.
    /// @param tableId Table id.
    /// @param cleartexts `abiEncodedClearValues` from the relayer's `publicDecrypt(revealHandles(tableId))`.
    /// @param proof `decryptionProof` from the same call.
    function finalizeReveal(uint256 tableId, bytes calldata cleartexts, bytes calldata proof) external {
        Table storage t = _tableInPhase(tableId, Phase.AwaitingReveal);
        bytes32[] memory handles = _revealHandles(t);
        uint256 expectedLength = handles.length * 32;
        if (cleartexts.length != expectedLength) revert InvalidCleartextsLength(expectedLength, cleartexts.length);

        t.phase = Phase.Settled;
        FHE.checkSignatures(handles, cleartexts, proof);

        uint8 count = RevealDecoder.countFace(cleartexts, handles.length, t.bidFace);
        uint8 loser = count >= t.bidQuantity ? t.liarCallerSeat : t.bidderSeat;
        t.revealedCount = count;
        _settle(t, loser);

        emit RoundRevealed(tableId, t.round, t.players[loser], count, t.bidQuantity, t.bidFace);
    }

    /// @notice Cancels a table whose reveal proof did not arrive before the proof deadline.
    /// @dev Only AwaitingReveal in Phase B (Phase C adds AwaitingPaidProof and refunds each seat's
    ///      `transferred`). Permissionless. The dice stay publicly decryptable: there is no revoke.
    ///      FHE ops: 0.
    /// @param tableId Table id.
    function cancel(uint256 tableId) external {
        Table storage t = _existingTable(tableId);
        if (t.phase != Phase.AwaitingReveal) revert NotCancellable(tableId, t.phase);
        if (block.timestamp <= t.deadline) revert DeadlineNotPassed(tableId, t.deadline);

        t.phase = Phase.Cancelled;
        emit TableCancelled(tableId);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Public state of a table.
    /// @param tableId Table id.
    /// @return v Table state without ciphertext handles.
    function getTable(uint256 tableId) external view returns (TableView memory v) {
        Table storage t = _existingTable(tableId);
        v = TableView({
            phase: t.phase,
            maxPlayers: t.maxPlayers,
            playerCount: t.playerCount,
            turnSeat: t.turnSeat,
            bidQuantity: t.bidQuantity,
            bidFace: t.bidFace,
            bidderSeat: t.bidderSeat,
            liarCallerSeat: t.liarCallerSeat,
            loserSeat: t.loserSeat,
            revealedCount: t.revealedCount,
            round: t.round,
            deadline: t.deadline,
            stake: t.stake,
            players: t.players
        });
    }

    /// @notice Encrypted dice handles of a seated player. Handles are not secret: the ACL decides who
    ///         can decrypt them (the owner only, until the reveal).
    /// @param tableId Table id.
    /// @param player Seated player.
    /// @return dice Five handles; all zero before the game starts.
    function diceOf(uint256 tableId, address player) external view returns (euint8[DICE_PER_PLAYER] memory dice) {
        Table storage t = _existingTable(tableId);
        uint8 seat = _seatOf(t, player);
        if (seat == NO_SEAT) revert NotPlayer(tableId, player);
        dice = t.dice[seat];
    }

    /// @notice Exact ordered handle list that `finalizeReveal` checks: seat 0..maxPlayers-1, then die 0..4.
    ///         Pass it unchanged to the relayer's `publicDecrypt`.
    /// @dev Reverts `LiarNotCalled` while the dice are not public. Stays readable after Settled and
    ///      Cancelled so any finished round can be re-verified from public data.
    /// @param tableId Table id.
    /// @return handles maxPlayers * 5 dice handles.
    function revealHandles(uint256 tableId) external view returns (bytes32[] memory handles) {
        Table storage t = _existingTable(tableId);
        if (t.liarCallerSeat == NO_SEAT) revert LiarNotCalled(tableId);
        handles = _revealHandles(t);
    }

    /// @notice Seat of a player.
    /// @param tableId Table id.
    /// @param player Player address.
    /// @return Seat index, or NO_SEAT if not seated.
    function seatOf(uint256 tableId, address player) external view returns (uint8) {
        return _seatOf(_existingTable(tableId), player);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    /// @dev Seats `player` at the first empty seat. Caller guarantees the table is Joining and not full.
    function _seat(uint256 tableId, Table storage t, address player) private {
        uint8 seat = 0;
        while (t.players[seat] != address(0)) ++seat;
        t.players[seat] = player;
        ++t.playerCount;
        emit PlayerJoined(tableId, player, seat);
    }

    /// @dev Rolls DICE_PER_PLAYER dice for every seat; each die is allowed to this contract and its
    ///      owner only. FHE ops: 6 per die (D6.roll) + 2 ACL calls per die. HCU: 507,064 per die,
    ///      depth 507,064 (dice are independent). Seat 0 bids first.
    function _startGame(uint256 tableId, Table storage t) private {
        for (uint8 seat = 0; seat < t.maxPlayers; ++seat) {
            address owner = t.players[seat];
            for (uint8 i = 0; i < DICE_PER_PLAYER; ++i) {
                euint8 die = D6.roll();
                FHE.allowThis(die);
                FHE.allow(die, owner);
                t.dice[seat][i] = die;
            }
        }

        uint64 deadline = uint64(block.timestamp) + BID_TIMEOUT;
        t.round = 1;
        t.phase = Phase.Bidding;
        t.turnSeat = 0;
        t.deadline = deadline;

        emit GameStarted(tableId, 1, 0, deadline);
    }

    /// @dev Ends the round with `loser` losing. The caller has already set the phase to Settled.
    ///      Phase C pays `n * stake / (n - 1)` to every other seat here, with plain `confidentialTransfer`
    ///      (never `...AndCall`: a winner's receiver hook could make the payout revert).
    function _settle(Table storage t, uint8 loser) private {
        t.loserSeat = loser;
        t.turnSeat = NO_SEAT;
    }

    /// @dev Dice handles in reveal order: seat 0..maxPlayers-1, then die 0..4.
    function _revealHandles(Table storage t) private view returns (bytes32[] memory handles) {
        uint256 n = uint256(t.maxPlayers) * DICE_PER_PLAYER;
        handles = new bytes32[](n);
        uint256 k = 0;
        for (uint8 seat = 0; seat < t.maxPlayers; ++seat) {
            for (uint8 i = 0; i < DICE_PER_PLAYER; ++i) {
                handles[k] = FHE.toBytes32(t.dice[seat][i]);
                ++k;
            }
        }
    }

    /// @dev Reverts unless the caller is the player on turn.
    function _requireTurn(uint256 tableId, Table storage t) private view {
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == NO_SEAT) revert NotPlayer(tableId, msg.sender);
        if (seat != t.turnSeat) revert NotYourTurn(tableId, t.players[t.turnSeat], msg.sender);
    }

    /// @dev Reverts unless (quantity, face) is a legal bid that raises the current one.
    function _validateBid(Table storage t, uint8 quantity, uint8 face) private view {
        if (face == 0 || face > FACES) revert InvalidFace(face);
        uint8 maxQuantity = t.playerCount * DICE_PER_PLAYER;
        if (quantity == 0 || quantity > maxQuantity) revert InvalidQuantity(quantity, maxQuantity);

        uint8 prevQuantity = t.bidQuantity;
        uint8 prevFace = t.bidFace;
        bool raises = quantity > prevQuantity || (quantity == prevQuantity && face > prevFace);
        if (!raises) revert BidNotHigher(prevQuantity, prevFace, quantity, face);
    }

    /// @dev Returns the table, reverting if it does not exist.
    function _existingTable(uint256 tableId) private view returns (Table storage t) {
        t = _tables[tableId];
        if (t.phase == Phase.None) revert TableNotFound(tableId);
    }

    /// @dev Returns the table, reverting if it does not exist or is not in `expected`.
    function _tableInPhase(uint256 tableId, Phase expected) private view returns (Table storage t) {
        t = _existingTable(tableId);
        if (t.phase != expected) revert WrongPhase(tableId, expected, t.phase);
    }

    /// @dev Seat of `player`, or NO_SEAT. address(0) is never seated.
    function _seatOf(Table storage t, address player) private view returns (uint8) {
        if (player == address(0)) return NO_SEAT;
        for (uint8 seat = 0; seat < MAX_PLAYERS; ++seat) {
            if (t.players[seat] == player) return seat;
        }
        return NO_SEAT;
    }
}
