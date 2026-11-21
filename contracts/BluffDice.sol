// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint8, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {D6} from "./lib/D6.sol";
import {RevealDecoder} from "./lib/RevealDecoder.sol";

/// @title BluffDice
/// @author Bluff Dice
/// @notice Confidential Liar's Dice. Every die is rolled onchain with FHE randomness and stays encrypted:
///         only its owner can decrypt it. Bids are public. "Liar" makes every die of the round publicly
///         decryptable; anyone then submits the clear dice with the KMS proof, and the contract counts the
///         bid face in plaintext. Stakes are pulled in a confidential ERC-7984 token; whether a stake arrived is
///         checked with a public KMS proof before any die is rolled. The KMS proof is the only authority;
///         handles always come from storage.
/// @dev One contract holds every table in a mapping (no clones: `ZamaEthereumConfig` configures the
///      coprocessor in the constructor, which a minimal proxy would skip).
///      Nothing in this contract branches on an encrypted value, so gas never depends on a secret.
///      Token requirements (the game is token-agnostic, but relies on these): transfers are all-or-nothing
///      (an insufficient balance moves exactly 0, as in OZ `ERC7984`), no transfer fee, no hook on a plain
///      `confidentialTransfer`, no pause and no denylist. A pausing or denylisting token can freeze a table
///      forever (payouts and refunds are pushed in one transaction); a token that moves partial amounts would
///      strand the partial stake of a dropped non-payer.
contract BluffDice is ZamaEthereumConfig, ReentrancyGuardTransient {
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
    /// @notice Time allowed for a decryption proof (the paid flags in AwaitingPaidProof, the dice in
    ///         AwaitingReveal) before anyone may `cancel`. A late proof is still accepted until someone cancels.
    uint64 public constant PROOF_TIMEOUT = 1 hours;
    /// @notice Sentinel for "no seat".
    uint8 public constant NO_SEAT = type(uint8).max;

    /// @notice The chip token stakes are paid in.
    IERC7984 public immutable TOKEN;
    /// @notice Time the player on turn has to act before anyone can claim the timeout.
    uint64 public immutable BID_TIMEOUT;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Table lifecycle: Joining -> AwaitingPaidProof -> Bidding -> AwaitingReveal -> Settled.
    ///         A failed paid check goes back to Joining; Cancelled can follow Joining (last leaver or every
    ///         seat dropped), AwaitingPaidProof or AwaitingReveal (proof deadline passed).
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
    ///      There is no encrypted pot (SPEC, Phase C approval 1): once every paid flag is verified the
    ///      table's escrow is exactly `maxPlayers * stake`, and refunds use each seat's own `transferred`.
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
        uint64 deadline; // turn deadline while Bidding, proof deadline while Awaiting*, 0 while Joining
        uint64 stake; // public, fixed per table, pulled at create/join
        address[MAX_PLAYERS] players; // seat -> player, address(0) = empty seat
        euint8[DICE_PER_PLAYER][MAX_PLAYERS] dice; // seat -> encrypted dice (owner-only ACL)
        euint64[MAX_PLAYERS] transferred; // seat -> amount the token actually moved at join (stake or 0)
        euint8[MAX_PLAYERS] paid; // seat -> 1 if transferred == stake, else 0 (euint8, publicly decrypted)
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

    /// @notice Addresses dropped from a table as non-payers; they cannot rejoin that table.
    mapping(uint256 tableId => mapping(address player => bool isDropped)) public dropped;

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

    /// @notice A player took a seat (their stake pull happened in the same transaction).
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

    /// @notice The table is full; every seat's paid flag is now publicly decryptable (forever). Anyone can
    ///         fetch the clear flags with the KMS proof and call `startGame`.
    /// @param tableId Table id.
    /// @param deadline After this time anyone may `cancel` if no proof was submitted.
    event PaidCheckRequested(uint256 indexed tableId, uint64 deadline);

    /// @notice A seated player's stake did not arrive; the seat reopens and the player cannot rejoin.
    /// @param tableId Table id.
    /// @param player Dropped player.
    /// @param seat Seat that reopened.
    event PlayerDropped(uint256 indexed tableId, address indexed player, uint8 seat);

    /// @notice Every paid flag was verified and every player got their encrypted dice.
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

    /// @notice A winner was paid their share of the escrow (public amount).
    /// @param tableId Table id.
    /// @param round Round number.
    /// @param winner Paid player.
    /// @param amount `maxPlayers * stake / (maxPlayers - 1)`.
    event WinningsPaid(uint256 indexed tableId, uint32 indexed round, address indexed winner, uint64 amount);

    /// @notice A player's own stake went back to them (leave or cancel). The amount stays encrypted: it is the
    ///         stake for a payer and 0 for a non-payer, and the contract cannot tell which.
    /// @param tableId Table id.
    /// @param player Refunded player.
    /// @param seat Their seat.
    /// @param amount Handle of the amount the token moved (the player can decrypt it with contract = token).
    event StakeRefunded(uint256 indexed tableId, address indexed player, uint8 seat, euint64 amount);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice The token address given to the constructor is zero.
    error InvalidToken();
    /// @notice The bid timeout given to the constructor is zero.
    error InvalidBidTimeout();
    /// @notice Stake is zero, too large, or not divisible by `maxPlayers - 1` (the payout would leave dust).
    error InvalidStake(uint64 stake, uint8 maxPlayers);
    /// @notice `maxPlayers` is outside 2..4.
    error InvalidMaxPlayers(uint8 maxPlayers);
    /// @notice No table with this id.
    error TableNotFound(uint256 tableId);
    /// @notice The table is not in the phase this action needs.
    error WrongPhase(uint256 tableId, Phase expected, Phase actual);
    /// @notice The caller already has a seat at this table.
    error AlreadySeated(uint256 tableId, address player);
    /// @notice The caller was dropped from this table as a non-payer.
    error DroppedFromTable(uint256 tableId, address player);
    /// @notice The joiner's paid-flag handle equals another seat's. Handles are deterministic: two
    ///         never-funded joins at the same stake produce the same handle, which would put one handle
    ///         twice in the paid-check list. Equal handles mean equal values, so this reveals nothing new.
    error DuplicatePaidHandle(uint8 seat);
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
    /// @notice A paid-flag handle is empty. Invariant guard: never reveal an uninitialized handle.
    error PaidFlagNotInitialized(uint8 seat);
    /// @notice The paid flags of this table were never made public (it never filled up).
    error PaidCheckNotRequested(uint256 tableId);
    /// @notice Nobody called "Liar" on this table, so its dice are not public.
    error LiarNotCalled(uint256 tableId);
    /// @notice `cleartexts` is not exactly one 32-byte word per handle.
    error InvalidCleartextsLength(uint256 expected, uint256 actual);
    /// @notice The table cannot be cancelled in this phase.
    error NotCancellable(uint256 tableId, Phase phase);

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @notice Deploys the game.
    /// @param token ERC-7984 chip token (see the contract-level token requirements).
    /// @param bidTimeout Seconds the player on turn has to act (deploy default: 300 = 5 minutes).
    constructor(IERC7984 token, uint64 bidTimeout) {
        if (address(token) == address(0)) revert InvalidToken();
        if (bidTimeout == 0) revert InvalidBidTimeout();
        TOKEN = token;
        BID_TIMEOUT = bidTimeout;
    }

    // ---------------------------------------------------------------------------------------------
    // Table lifecycle
    // ---------------------------------------------------------------------------------------------

    /// @notice Creates a table, seats the caller at seat 0 and pulls their stake.
    /// @dev The caller must have made this contract an operator of the token (`setOperator`).
    ///      FHE ops: see `_pullStake` (game 3, token 6; 669,096 HCU for a funded creator).
    /// @param stake Public stake per player, in token base units; must be divisible by `maxPlayers - 1`.
    /// @param maxPlayers Seats at the table (2..4). The paid check starts when all seats are taken.
    /// @return tableId Id of the new table.
    function createTable(uint64 stake, uint8 maxPlayers) external nonReentrant returns (uint256 tableId) {
        if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) revert InvalidMaxPlayers(maxPlayers);
        if (stake == 0 || stake % (maxPlayers - 1) != 0 || stake > type(uint64).max / MAX_PLAYERS) {
            revert InvalidStake(stake, maxPlayers);
        }

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
        uint8 seat = _seat(tableId, t, msg.sender);
        _pullStake(t, seat);
    }

    /// @notice Takes a seat and pulls the stake. The join that fills the table makes every seat's paid flag
    ///         publicly decryptable and moves the table to AwaitingPaidProof; no die is rolled yet.
    /// @dev The caller must have made this contract an operator of the token. A low balance does not revert:
    ///      the token moves 0 and the seat's paid flag is 0 (decided by `startGame`).
    ///      FHE ops: see `_pullStake`. The filling join adds `maxPlayers` `makePubliclyDecryptable` ACL calls.
    /// @param tableId Table to join.
    function joinTable(uint256 tableId) external nonReentrant {
        Table storage t = _tableInPhase(tableId, Phase.Joining);
        if (_seatOf(t, msg.sender) != NO_SEAT) revert AlreadySeated(tableId, msg.sender);
        if (dropped[tableId][msg.sender]) revert DroppedFromTable(tableId, msg.sender);

        uint8 seat = _seat(tableId, t, msg.sender);
        _pullStake(t, seat);
        if (t.playerCount == t.maxPlayers) _requestPaidCheck(tableId, t);
    }

    /// @notice Leaves a table that has not filled up and gets the own stake back. The seat reopens; the last
    ///         leaver cancels the table.
    /// @dev Only while Joining: once the paid check runs nobody may leave (only `cancel` after the deadline),
    ///      and once dice are rolled there is no selective abort. The refund is the seat's own `transferred`
    ///      (stake or an encrypted 0; same code path and gas either way).
    ///      FHE ops: token `confidentialTransfer` (6 ops, about 586k HCU).
    /// @param tableId Table to leave.
    function leaveTable(uint256 tableId) external nonReentrant {
        Table storage t = _tableInPhase(tableId, Phase.Joining);
        uint8 seat = _seatOf(t, msg.sender);
        if (seat == NO_SEAT) revert NotPlayer(tableId, msg.sender);

        euint64 refund = t.transferred[seat];
        _clearSeat(t, seat);
        emit PlayerLeft(tableId, msg.sender, seat);

        if (t.playerCount == 0) {
            t.phase = Phase.Cancelled;
            emit TableCancelled(tableId);
        }
        _refund(tableId, msg.sender, seat, refund);
    }

    /// @notice Verifies every seat's paid flag with the KMS proof. If all paid, rolls the dice and starts the
    ///         round; otherwise drops the non-payers (their seats reopen) and the table waits for new players.
    ///         Permissionless: the KMS proof is the authority, not the caller.
    /// @dev Steps: (1) phase must be AwaitingPaidProof (the replay guard); (2) the handle list is rebuilt from
    ///      STORAGE (same order as `paidHandles`); (3) exactly one 32-byte word per seat; (4) the phase leaves
    ///      AwaitingPaidProof before the proof check; (5) `FHE.checkSignatures`; (6) every word must be 0 or 1.
    ///      A dropped non-payer gets nothing back: an all-or-nothing token moved exactly 0 for them.
    ///      Replay: unlike dice, paid handles are not always fresh. After a drop, a never-funded refiller in the
    ///      same seat recreates the same handle, so an old proof can be valid again. That is safe: a proof can
    ///      only carry the true values of its handles, and the phase guard stops double processing.
    ///      Accepted after the proof deadline too, until someone calls `cancel`.
    ///      FHE ops: check 0 (0 HCU, one `checkSignatures`). All paid: `_startGame`, 6 ops + 2 ACL calls per die
    ///      (4 players: 120 FHE ops, 10,141,280 HCU, depth 507,064).
    /// @param tableId Table id.
    /// @param cleartexts `abiEncodedClearValues` from the relayer's `publicDecrypt(paidHandles(tableId))`.
    /// @param proof `decryptionProof` from the same call.
    function startGame(uint256 tableId, bytes calldata cleartexts, bytes calldata proof) external nonReentrant {
        Table storage t = _tableInPhase(tableId, Phase.AwaitingPaidProof);
        bytes32[] memory handles = _paidHandles(t);
        uint256 expectedLength = handles.length * 32;
        if (cleartexts.length != expectedLength) revert InvalidCleartextsLength(expectedLength, cleartexts.length);

        t.phase = Phase.Joining; // provisional; every path below sets the final phase
        FHE.checkSignatures(handles, cleartexts, proof);

        uint8 mask = RevealDecoder.paidMask(cleartexts, handles.length);
        if (mask == uint8((1 << t.maxPlayers) - 1)) {
            _startGame(tableId, t);
            return;
        }

        t.deadline = 0;
        for (uint8 seat = 0; seat < t.maxPlayers; ++seat) {
            if (mask & (1 << seat) != 0) continue;
            address player = t.players[seat];
            dropped[tableId][player] = true;
            _clearSeat(t, seat);
            emit PlayerDropped(tableId, player, seat);
        }
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

    /// @notice Anyone can end a round whose player on turn did not act in time; that player loses and every
    ///         other player is paid.
    /// @dev The dice are NOT revealed: a timeout never makes anything publicly decryptable.
    ///      FHE ops: `_settle` only (1 trivial encrypt + (n-1) token transfers).
    /// @param tableId Table id.
    function claimTurnTimeout(uint256 tableId) external nonReentrant {
        Table storage t = _tableInPhase(tableId, Phase.Bidding);
        if (block.timestamp <= t.deadline) revert DeadlineNotPassed(tableId, t.deadline);

        uint8 loser = t.turnSeat;
        t.phase = Phase.Settled;
        emit TurnTimedOut(tableId, t.round, t.players[loser]);
        _settle(tableId, t, loser);
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

    /// @notice Settles a challenged round from the publicly decrypted dice and pays the winners.
    ///         Permissionless: the KMS proof is the authority, not the caller.
    /// @dev Steps: (1) phase must be AwaitingReveal; (2) the handle list is rebuilt from STORAGE (same
    ///      order as `revealHandles`), never taken from calldata; (3) exactly one 32-byte word per handle;
    ///      (4) phase = Settled before any external call; (5) `FHE.checkSignatures` reverts on any
    ///      wrong value, order, handle or signature and emits `PublicDecryptionVerified`; (6) words are
    ///      decoded one by one, each must be 1..6; (7) count >= quantity -> the caller loses (a tie means
    ///      the bid was true), otherwise the bidder loses; (8) `_settle` pays every other player.
    ///      Replay protection: the phase guard alone. Table ids are unique, Settled and Cancelled are final,
    ///      and the handles come from storage. A proof is bound to its round by the handles (every roll
    ///      creates fresh handles), not by `round`. Invariant for any future multi-round mode: every round
    ///      must re-roll every die and reset `liarCallerSeat`, otherwise an old proof becomes valid again.
    ///      Accepted after the proof deadline too, until someone calls `cancel`.
    ///      FHE ops: 0 for the check (one `checkSignatures`), then `_settle` (1 trivial encrypt + (n-1) token
    ///      transfers; 4 players about 1.76M HCU).
    /// @param tableId Table id.
    /// @param cleartexts `abiEncodedClearValues` from the relayer's `publicDecrypt(revealHandles(tableId))`.
    /// @param proof `decryptionProof` from the same call.
    function finalizeReveal(uint256 tableId, bytes calldata cleartexts, bytes calldata proof) external nonReentrant {
        Table storage t = _tableInPhase(tableId, Phase.AwaitingReveal);
        bytes32[] memory handles = _revealHandles(t);
        uint256 expectedLength = handles.length * 32;
        if (cleartexts.length != expectedLength) revert InvalidCleartextsLength(expectedLength, cleartexts.length);

        t.phase = Phase.Settled;
        FHE.checkSignatures(handles, cleartexts, proof);

        uint8 count = RevealDecoder.countFace(cleartexts, handles.length, t.bidFace);
        uint8 loser = count >= t.bidQuantity ? t.liarCallerSeat : t.bidderSeat;
        t.revealedCount = count;

        emit RoundRevealed(tableId, t.round, t.players[loser], count, t.bidQuantity, t.bidFace);
        _settle(tableId, t, loser);
    }

    /// @notice Cancels a table whose decryption proof (paid flags or dice) did not arrive before the deadline
    ///         and refunds every seated player their own stake.
    /// @dev AwaitingPaidProof or AwaitingReveal only. Permissionless. Each refund is the seat's own
    ///      `transferred` (stake, or an encrypted 0 for a non-payer whose flag was never verified).
    ///      Dice made public by "Liar" stay public: there is no revoke.
    ///      FHE ops: one token `confidentialTransfer` per seated player (4 players about 2.34M HCU).
    /// @param tableId Table id.
    function cancel(uint256 tableId) external nonReentrant {
        Table storage t = _existingTable(tableId);
        if (t.phase != Phase.AwaitingPaidProof && t.phase != Phase.AwaitingReveal) {
            revert NotCancellable(tableId, t.phase);
        }
        if (block.timestamp <= t.deadline) revert DeadlineNotPassed(tableId, t.deadline);

        t.phase = Phase.Cancelled;
        emit TableCancelled(tableId);

        for (uint8 seat = 0; seat < t.maxPlayers; ++seat) {
            address player = t.players[seat];
            if (player != address(0)) _refund(tableId, player, seat, t.transferred[seat]);
        }
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

    /// @notice Stake handles of a seated player.
    /// @param tableId Table id.
    /// @param player Seated player.
    /// @return transferred Amount the token moved at join (decrypt with contract = TOKEN; player only).
    /// @return paid 1 if `transferred == stake`, else 0 (decrypt with contract = this game; the player only,
    ///         until the table fills, then public).
    function stakeOf(uint256 tableId, address player) external view returns (euint64 transferred, euint8 paid) {
        Table storage t = _existingTable(tableId);
        uint8 seat = _seatOf(t, player);
        if (seat == NO_SEAT) revert NotPlayer(tableId, player);
        transferred = t.transferred[seat];
        paid = t.paid[seat];
    }

    /// @notice Exact ordered handle list that `startGame` checks: the paid flag of seat 0..maxPlayers-1.
    ///         Pass it unchanged to the relayer's `publicDecrypt`.
    /// @dev Reverts `PaidCheckNotRequested` when the table never filled up (Joining, or Cancelled by its last
    ///      leaver / with every seat dropped, which leave `deadline == 0`). Stays readable afterwards so a
    ///      finished table's paid check can be re-verified.
    /// @param tableId Table id.
    /// @return handles maxPlayers paid-flag handles.
    function paidHandles(uint256 tableId) external view returns (bytes32[] memory handles) {
        Table storage t = _existingTable(tableId);
        if (t.phase == Phase.Joining || (t.phase == Phase.Cancelled && t.deadline == 0)) {
            revert PaidCheckNotRequested(tableId);
        }
        handles = _paidHandles(t);
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
    function _seat(uint256 tableId, Table storage t, address player) private returns (uint8 seat) {
        while (t.players[seat] != address(0)) ++seat;
        t.players[seat] = player;
        ++t.playerCount;
        emit PlayerJoined(tableId, player, seat);
    }

    /// @dev Empties a seat: player, stake handles. Dice are never set while a seat can be emptied.
    function _clearSeat(Table storage t, uint8 seat) private {
        delete t.players[seat];
        t.transferred[seat] = euint64.wrap(bytes32(0)); // `delete` does not apply to user-defined value types
        t.paid[seat] = euint8.wrap(bytes32(0));
        --t.playerCount;
    }

    /// @dev Pulls the public stake from `msg.sender` (ALWAYS the caller, never a parameter: anyone with a live
    ///      operator approval could otherwise be force-joined) and records what arrived.
    ///      `transferred` is all-or-nothing (stake or 0); `paid = asEuint8(eq(transferred, stake))` is a
    ///      euint8 0/1, the value made public when the table fills (SPEC, Phase C approval 7).
    ///      FHE ops: game 3 (trivial encrypt 32, eq scalar euint64 83,000, cast ebool->euint8 32 HCU);
    ///      token `_update` 6 (586,032 HCU for a funded sender). Total 669,096 HCU, depth about 369k.
    ///      ACL: token allowed transiently on the amount; this contract and the player persistently on `paid`;
    ///      the token grants this contract and the player `transferred`; `allowThis` on both anyway.
    function _pullStake(Table storage t, uint8 seat) private {
        uint64 stake = t.stake;
        euint64 amount = FHE.asEuint64(stake);
        FHE.allowTransient(amount, address(TOKEN));
        euint64 transferred = TOKEN.confidentialTransferFrom(msg.sender, address(this), amount);
        euint8 paid = FHE.asEuint8(FHE.eq(transferred, stake));

        bytes32 paidHandle = FHE.toBytes32(paid);
        for (uint8 other = 0; other < MAX_PLAYERS; ++other) {
            if (other != seat && t.players[other] != address(0) && FHE.toBytes32(t.paid[other]) == paidHandle) {
                revert DuplicatePaidHandle(seat);
            }
        }

        FHE.allowThis(transferred);
        FHE.allowThis(paid);
        FHE.allow(paid, msg.sender);
        t.transferred[seat] = transferred;
        t.paid[seat] = paid;
    }

    /// @dev The table is full: every paid flag becomes publicly decryptable and the proof clock starts.
    ///      Re-publishing a payer's flag that is already public (after a drop + refill) is harmless.
    function _requestPaidCheck(uint256 tableId, Table storage t) private {
        for (uint8 seat = 0; seat < t.maxPlayers; ++seat) {
            euint8 flag = t.paid[seat];
            if (!FHE.isInitialized(flag)) revert PaidFlagNotInitialized(seat);
            FHE.makePubliclyDecryptable(flag);
        }
        uint64 deadline = uint64(block.timestamp) + PROOF_TIMEOUT;
        t.deadline = deadline;
        t.phase = Phase.AwaitingPaidProof;
        emit PaidCheckRequested(tableId, deadline);
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

    /// @dev Ends the round with `loser` losing. The caller has already set the phase to Settled (the guard
    ///      against a second payout). Every other seat gets `(stake / (n - 1)) * n` (exact, see `createTable`)
    ///      with a plain `confidentialTransfer` (never `...AndCall`: a winner's receiver hook could make the
    ///      payout revert). The escrow is exactly `n * stake` because `startGame` verified every paid flag.
    ///      FHE ops: 1 trivial encrypt + (n-1) token `_update` (6 ops each).
    function _settle(uint256 tableId, Table storage t, uint8 loser) private {
        t.loserSeat = loser;
        t.turnSeat = NO_SEAT;

        uint64 n = t.maxPlayers;
        uint64 share = (t.stake / (n - 1)) * n;
        euint64 amount = FHE.asEuint64(share);
        FHE.allowTransient(amount, address(TOKEN));
        for (uint8 seat = 0; seat < t.maxPlayers; ++seat) {
            if (seat == loser) continue;
            address winner = t.players[seat];
            TOKEN.confidentialTransfer(winner, amount);
            emit WinningsPaid(tableId, t.round, winner, share);
        }
    }

    /// @dev Sends a player their own stored stake handle back. The token needs a transient allowance on it.
    function _refund(uint256 tableId, address player, uint8 seat, euint64 amount) private {
        FHE.allowTransient(amount, address(TOKEN));
        euint64 moved = TOKEN.confidentialTransfer(player, amount);
        emit StakeRefunded(tableId, player, seat, moved);
    }

    /// @dev Paid-flag handles in seat order.
    function _paidHandles(Table storage t) private view returns (bytes32[] memory handles) {
        handles = new bytes32[](t.maxPlayers);
        for (uint8 seat = 0; seat < t.maxPlayers; ++seat) {
            handles[seat] = FHE.toBytes32(t.paid[seat]);
        }
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
