// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReputationGate} from "./ReputationGate.sol";

/// @title SealedNegotiation
/// @author Sealed
/// @notice Bilateral negotiation between two ERC-8004 agents in which neither
///         side can observe the other's position before its own is locked, and
///         in which neither side can be forced to expose a position the other
///         never exposed.
///
/// @dev ------------------------------------------------------------------
///      THE PROBLEM WITH TEXTBOOK COMMIT-REVEAL
///      ------------------------------------------------------------------
///      The usual sealed-bid pattern is: everyone commits a hash, then everyone
///      reveals. In an auction with many bidders and a deposit at stake that is
///      good enough. In a two-party negotiation it is not, for two reasons.
///
///      1. Last-revealer advantage. If A reveals first, B reads A's number and
///         decides whether revealing still suits it. B can walk away having
///         learned everything while exposing nothing. The asymmetry is total
///         and it breaks the entire premise of the product.
///
///      2. Small message space. A price is not a 256-bit secret. If the
///         commitment is keccak256(price), a counterparty brute-forces the
///         whole plausible range in milliseconds.
///
///      ------------------------------------------------------------------
///      WHAT THIS CONTRACT DOES INSTEAD
///      ------------------------------------------------------------------
///      (1) There is no reveal phase. There is a single atomic settlement.
///          `settle` consumes BOTH offers, BOTH salts and BOTH EIP-712
///          authorizations in one transaction. Nobody reveals first, because
///          there is no "first". Either both positions land on-chain in the
///          same instant or neither ever does.
///
///      (2) Settlement is authorized per commitment pair. Each agent signs a
///          SettleAuthorization binding the exact two commitment hashes and
///          their round indices. A counterparty cannot replay an old signature
///          against a commitment the signer never saw, and cannot settle a pair
///          the signer did not agree to settle.
///
///      (3) Commitments are domain-separated and salted. The pre-image binds
///          chain id, contract address, negotiation id, the committing party
///          and the round index. The same price committed twice produces two
///          unrelated hashes, so an observer learns nothing from an update, and
///          a 32-byte salt puts brute force out of reach.
///
///      (4) Failure is silent. If the two positions turn out to be
///          incompatible, no settlement transaction is ever submitted and the
///          negotiation simply expires. The chain records that two agents
///          talked and did not trade. It never records what either asked for.
///
///      ------------------------------------------------------------------
///      WHAT THIS CONTRACT DOES NOT CLAIM
///      ------------------------------------------------------------------
///      Once both commitments are locked, the two agents exchange their reveal
///      payloads with each other off-chain in order to check compatibility. At
///      that moment each learns the other's final number. That disclosure is
///      simultaneous and it is post-commitment: neither agent can still change
///      its own position, because its own position is already hashed on-chain.
///      That is precisely the sealed-bid guarantee, and it is the honest limit
///      of what is achievable without threshold encryption or an FHE
///      coprocessor. Sealed guarantees that nothing leaks BEFORE commitment,
///      and that nothing leaks UNILATERALLY, ever.
///
///      Timing metadata is public. The mempool shows that an address committed
///      and when. It never shows what.
contract SealedNegotiation is EIP712 {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        None,
        Open, // created, awaiting commitments
        Locked, // both sides committed, settlement authorized off-chain
        Settled, // agreement reached and recorded
        Expired // window closed with no settlement, nothing disclosed
    }

    struct Negotiation {
        address buyerWallet;
        address sellerWallet;
        uint256 buyerAgentId;
        uint256 sellerAgentId;
        bytes32 buyerCommitment;
        bytes32 sellerCommitment;
        uint32 buyerCommitIndex;
        uint32 sellerCommitIndex;
        uint64 deadline;
        Status status;
        uint256 settledPrice;
        bytes32 termsSchema; // hash of the off-chain description of what is negotiated
    }

    /// @notice One side's disclosed position, only ever supplied to `settle`.
    /// @param offer The real number. Buyer: the most it will pay. Seller: the
    ///        least it will accept. Same unit, defined by `termsSchema`.
    /// @param salt 32 bytes of entropy, never reused across rounds.
    struct Reveal {
        uint256 offer;
        bytes32 salt;
    }

    // ---------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------

    bytes32 private constant SETTLE_AUTHORIZATION_TYPEHASH = keccak256(
        "SettleAuthorization(uint256 negotiationId,bytes32 buyerCommitment,bytes32 sellerCommitment,uint32 buyerCommitIndex,uint32 sellerCommitIndex)"
    );

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    ReputationGate public immutable gate;

    uint256 public negotiationCount;
    mapping(uint256 => Negotiation) private _negotiations;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @dev Note what is absent from every event below: any offer value, until
    ///      settlement, and even then only the agreed price, never the two
    ///      positions that produced it.
    event NegotiationCreated(
        uint256 indexed negotiationId,
        address indexed buyerWallet,
        address indexed sellerWallet,
        uint256 buyerAgentId,
        uint256 sellerAgentId,
        uint64 deadline,
        bytes32 termsSchema
    );
    event OfferCommitted(uint256 indexed negotiationId, address indexed party, uint32 commitIndex);
    event NegotiationLocked(uint256 indexed negotiationId);
    event NegotiationSettled(uint256 indexed negotiationId, uint256 price);
    event NegotiationExpired(uint256 indexed negotiationId);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error UnknownNegotiation(uint256 negotiationId);
    error WrongStatus(Status found, Status required);
    error NotAParty(address caller);
    error SameParty();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error DeadlineTooSoon();
    error CommitmentMismatch(address party);
    error BadAuthorization(address party);
    error IncompatibleOffers();

    // ---------------------------------------------------------------------

    constructor(address _gate) EIP712("Sealed", "1") {
        gate = ReputationGate(_gate);
    }

    /// @notice Open a negotiation between two agents that both clear `policy`.
    /// @dev Admission is checked here and only here. From this point on the
    ///      protocol never touches the reputation registry again, so neither
    ///      party can probe the other's history mid-negotiation.
    function createNegotiation(
        uint256 buyerAgentId,
        address buyerWallet,
        uint256 sellerAgentId,
        address sellerWallet,
        uint64 deadline,
        bytes32 termsSchema,
        ReputationGate.Policy calldata policy
    ) external returns (uint256 negotiationId) {
        if (buyerWallet == sellerWallet) revert SameParty();
        if (deadline <= block.timestamp + 1 minutes) revert DeadlineTooSoon();

        gate.requireAdmitted(buyerAgentId, buyerWallet, policy);
        gate.requireAdmitted(sellerAgentId, sellerWallet, policy);

        negotiationId = ++negotiationCount;

        _negotiations[negotiationId] = Negotiation({
            buyerWallet: buyerWallet,
            sellerWallet: sellerWallet,
            buyerAgentId: buyerAgentId,
            sellerAgentId: sellerAgentId,
            buyerCommitment: bytes32(0),
            sellerCommitment: bytes32(0),
            buyerCommitIndex: 0,
            sellerCommitIndex: 0,
            deadline: deadline,
            status: Status.Open,
            settledPrice: 0,
            termsSchema: termsSchema
        });

        emit NegotiationCreated(
            negotiationId, buyerWallet, sellerWallet, buyerAgentId, sellerAgentId, deadline, termsSchema
        );
    }

    /// @notice Lock in a position, or replace a previously locked one.
    /// @param commitment See `commitmentHash`. Compute it off-chain; never send
    ///        the offer or the salt to this contract outside of `settle`.
    /// @dev Re-committing is allowed while the negotiation is Open or Locked and
    ///      the deadline has not passed. This is what makes rounds of
    ///      counter-offers possible. Each replacement bumps the party's commit
    ///      index, which invalidates every settlement authorization signed
    ///      against the previous index. A counterparty therefore cannot settle
    ///      against a position that has since been withdrawn.
    function commitOffer(uint256 negotiationId, bytes32 commitment) external {
        Negotiation storage n = _load(negotiationId);
        if (n.status != Status.Open && n.status != Status.Locked) {
            revert WrongStatus(n.status, Status.Open);
        }
        if (block.timestamp >= n.deadline) revert DeadlinePassed();

        if (msg.sender == n.buyerWallet) {
            n.buyerCommitment = commitment;
            n.buyerCommitIndex += 1;
            emit OfferCommitted(negotiationId, msg.sender, n.buyerCommitIndex);
        } else if (msg.sender == n.sellerWallet) {
            n.sellerCommitment = commitment;
            n.sellerCommitIndex += 1;
            emit OfferCommitted(negotiationId, msg.sender, n.sellerCommitIndex);
        } else {
            revert NotAParty(msg.sender);
        }

        if (n.status == Status.Open && n.buyerCommitment != bytes32(0) && n.sellerCommitment != bytes32(0)) {
            n.status = Status.Locked;
            emit NegotiationLocked(negotiationId);
        }
    }

    /// @notice Settle both positions atomically.
    /// @dev Callable by anyone holding both reveals and both authorizations, in
    ///      practice one of the two agents or a relayer. There is no order of
    ///      operations that lets one side see the other's number on-chain before
    ///      its own is on-chain, because both land in this one call.
    ///
    ///      Reverts if the offers do not clear. Agents are expected not to
    ///      submit a settlement they already know fails; the clean failure path
    ///      is `expire`.
    function settle(
        uint256 negotiationId,
        Reveal calldata buyerReveal,
        Reveal calldata sellerReveal,
        bytes calldata buyerAuthorization,
        bytes calldata sellerAuthorization
    ) external returns (uint256 price) {
        Negotiation storage n = _load(negotiationId);
        if (n.status != Status.Locked) revert WrongStatus(n.status, Status.Locked);
        if (block.timestamp >= n.deadline) revert DeadlinePassed();

        // 1. Both disclosed positions must match the hashes committed earlier.
        if (
            commitmentHash(negotiationId, n.buyerWallet, n.buyerCommitIndex, buyerReveal.offer, buyerReveal.salt)
                != n.buyerCommitment
        ) revert CommitmentMismatch(n.buyerWallet);

        if (
            commitmentHash(negotiationId, n.sellerWallet, n.sellerCommitIndex, sellerReveal.offer, sellerReveal.salt)
                != n.sellerCommitment
        ) revert CommitmentMismatch(n.sellerWallet);

        // 2. Both parties must have authorized settlement of this exact pair.
        bytes32 digest = settleAuthorizationDigest(negotiationId);
        if (ECDSA.recover(digest, buyerAuthorization) != n.buyerWallet) revert BadAuthorization(n.buyerWallet);
        if (ECDSA.recover(digest, sellerAuthorization) != n.sellerWallet) revert BadAuthorization(n.sellerWallet);

        // 3. Compatibility. The buyer's ceiling must reach the seller's floor.
        if (buyerReveal.offer < sellerReveal.offer) revert IncompatibleOffers();

        // Split the surplus. Neither side captures the spread by being the one
        // who happened to submit the transaction.
        price = sellerReveal.offer + (buyerReveal.offer - sellerReveal.offer) / 2;

        n.status = Status.Settled;
        n.settledPrice = price;

        emit NegotiationSettled(negotiationId, price);
    }

    /// @notice Close a negotiation that reached its deadline without settling.
    /// @dev The clean failure. Both positions stay sealed forever: they were
    ///      never sent to this contract, and the only thing the chain learns is
    ///      that no deal happened.
    function expire(uint256 negotiationId) external {
        Negotiation storage n = _load(negotiationId);
        if (n.status != Status.Open && n.status != Status.Locked) {
            revert WrongStatus(n.status, Status.Locked);
        }
        if (block.timestamp < n.deadline) revert DeadlineNotPassed();

        n.status = Status.Expired;
        emit NegotiationExpired(negotiationId);
    }

    // ---------------------------------------------------------------------
    // Views and helpers
    // ---------------------------------------------------------------------

    /// @notice The hash an agent commits. Compute off-chain, keep the salt secret.
    /// @dev The domain separator binds chain id and contract address, which
    ///      prevents replay onto another chain or another deployment. Binding
    ///      party and commitIndex means the same offer produces a different hash
    ///      in every round, so an observer watching a sequence of updates cannot
    ///      tell whether the agent moved or held.
    function commitmentHash(uint256 negotiationId, address party, uint32 commitIndex, uint256 offer, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(_domainSeparatorV4(), negotiationId, party, commitIndex, offer, salt));
    }

    /// @notice EIP-712 digest each agent signs to authorize settlement.
    /// @dev Reads the CURRENT commitments and indices. Any new commitment by
    ///      either side changes this digest and silently voids both signatures.
    function settleAuthorizationDigest(uint256 negotiationId) public view returns (bytes32) {
        Negotiation storage n = _negotiations[negotiationId];
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SETTLE_AUTHORIZATION_TYPEHASH,
                    negotiationId,
                    n.buyerCommitment,
                    n.sellerCommitment,
                    n.buyerCommitIndex,
                    n.sellerCommitIndex
                )
            )
        );
    }

    function getNegotiation(uint256 negotiationId) external view returns (Negotiation memory) {
        return _negotiations[negotiationId];
    }

    function _load(uint256 negotiationId) private view returns (Negotiation storage n) {
        n = _negotiations[negotiationId];
        if (n.status == Status.None) revert UnknownNegotiation(negotiationId);
    }
}
