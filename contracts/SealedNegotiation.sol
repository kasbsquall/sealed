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
///          the signer did not agree to settle. Once both sides have committed
///          a round, neither can replace its commitment for that round alone,
///          so neither can void a pair both have signed. See `commitOffer`.
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
        Open, // created, awaiting the first complete round of commitments
        Locked, // both sides committed at least one round, settleable with both authorizations
        Settled, // agreement reached and recorded
        Expired // window closed with no settlement, nothing disclosed
    }

    struct Negotiation {
        address buyerWallet;
        address sellerWallet;
        uint256 buyerAgentId;
        uint256 sellerAgentId;
        bytes32 buyerCommitment; // the buyer's latest commitment
        bytes32 sellerCommitment; // the seller's latest commitment
        uint32 buyerCommitIndex; // round of the buyer's latest commitment
        uint32 sellerCommitIndex; // round of the seller's latest commitment
        uint64 deadline;
        Status status;
        uint256 settledPrice;
        bytes32 termsSchema; // hash of the off-chain description of what is negotiated
        bytes32 policyHash; // keccak256(abi.encode(policy)) of the admission policy checked at creation
    }

    /// @dev Each side's commitment for the round before its latest one. A side
    ///      that is one round ahead of the other still has its commitment for
    ///      the last complete round here, which is what `settle` reads.
    struct PreviousCommitments {
        bytes32 buyer;
        bytes32 seller;
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
    mapping(uint256 => PreviousCommitments) private _previous;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @dev No event below carries an offer value. The two positions become
    ///      public only through the calldata of `settle`, which carries both
    ///      offers and both salts; `NegotiationSettled` itself records only the
    ///      agreed price. A negotiation that expires never puts either offer
    ///      on-chain.
    event NegotiationCreated(
        uint256 indexed negotiationId,
        address indexed buyerWallet,
        address indexed sellerWallet,
        uint256 buyerAgentId,
        uint256 sellerAgentId,
        uint64 deadline,
        bytes32 termsSchema,
        bytes32 policyHash
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
    error AlreadyCommitted(uint32 commitIndex);

    // ---------------------------------------------------------------------

    constructor(address _gate) EIP712("Sealed", "1") {
        gate = ReputationGate(_gate);
    }

    /// @notice Open a negotiation between two agents that both clear `policy`.
    /// @dev Admission is checked here and only here. From this point on the
    ///      protocol never touches the reputation registry again, so neither
    ///      party can probe the other's history mid-negotiation.
    ///
    ///      The caller chooses the policy; neither party co-signs it. What the
    ///      contract guarantees is that the policy checked is the one recorded:
    ///      its hash is stored in the negotiation and emitted, so anyone holding
    ///      the policy (it is in this call's calldata) can confirm which
    ///      reviewers and thresholds admitted both agents.
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

        bytes32 policyHash = admissionPolicyHash(policy);
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
            termsSchema: termsSchema,
            policyHash: policyHash
        });

        emit NegotiationCreated(
            negotiationId, buyerWallet, sellerWallet, buyerAgentId, sellerAgentId, deadline, termsSchema, policyHash
        );
    }

    /// @notice Commit a position for the next round.
    /// @param commitment See `commitmentHash`, with `commitIndex` one above the
    ///        caller's current index. Compute it off-chain; never send the
    ///        offer or the salt to this contract outside of `settle`.
    /// @dev Rounds are how counter-offers work: each side commits once per
    ///      round, while the negotiation is Open or Locked and the deadline has
    ///      not passed. A round is complete when both sides have committed it,
    ///      and the settleable pair is always the last complete round.
    ///
    ///      Commit freeze. A side may be at most one round ahead of the other,
    ///      and committing never replaces a commitment for a round that is
    ///      still settleable: it opens the next round for that side and moves
    ///      its previous commitment to `_previous`, where `settle` still reads
    ///      it while the other side has not moved. So once both sides have
    ///      committed round r and signed that pair, neither can void it alone.
    ///      A party that sees the settlement in the mempool and races a new
    ///      commitment ahead of it only opens its own round r + 1; the
    ///      settlement still lands, and a second attempt reverts with
    ///      `AlreadyCommitted`. The pair moves on, voiding the round-r
    ///      authorizations, only when the other side commits round r + 1 too,
    ///      which an honest agent does only after learning that round r did
    ///      not cross.
    function commitOffer(uint256 negotiationId, bytes32 commitment) external {
        Negotiation storage n = _load(negotiationId);
        if (n.status != Status.Open && n.status != Status.Locked) {
            revert WrongStatus(n.status, Status.Open);
        }
        if (block.timestamp >= n.deadline) revert DeadlinePassed();

        if (msg.sender == n.buyerWallet) {
            if (n.buyerCommitIndex > n.sellerCommitIndex) revert AlreadyCommitted(n.buyerCommitIndex);
            _previous[negotiationId].buyer = n.buyerCommitment;
            n.buyerCommitment = commitment;
            n.buyerCommitIndex += 1;
            emit OfferCommitted(negotiationId, msg.sender, n.buyerCommitIndex);
        } else if (msg.sender == n.sellerWallet) {
            if (n.sellerCommitIndex > n.buyerCommitIndex) revert AlreadyCommitted(n.sellerCommitIndex);
            _previous[negotiationId].seller = n.sellerCommitment;
            n.sellerCommitment = commitment;
            n.sellerCommitIndex += 1;
            emit OfferCommitted(negotiationId, msg.sender, n.sellerCommitIndex);
        } else {
            revert NotAParty(msg.sender);
        }

        if (n.status == Status.Open && n.buyerCommitIndex != 0 && n.sellerCommitIndex != 0) {
            n.status = Status.Locked;
            emit NegotiationLocked(negotiationId);
        }
    }

    /// @notice Settle both positions of the last complete round atomically.
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

        // 1. Both disclosed positions must match the hashes committed for the
        //    last complete round.
        (bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 round) = _settleablePair(negotiationId, n);
        if (
            commitmentHash(negotiationId, n.buyerWallet, round, buyerReveal.offer, buyerReveal.salt) != buyerCommitment
        ) revert CommitmentMismatch(n.buyerWallet);

        if (
            commitmentHash(negotiationId, n.sellerWallet, round, sellerReveal.offer, sellerReveal.salt)
                != sellerCommitment
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
    /// @dev Covers the last complete round: both commitments and the round
    ///      index, once for each side. It changes only when both sides have
    ///      committed a new round, which voids the signatures over the old pair.
    ///      One side committing ahead leaves it unchanged.
    function settleAuthorizationDigest(uint256 negotiationId) public view returns (bytes32) {
        (bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 round) =
            _settleablePair(negotiationId, _negotiations[negotiationId]);
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SETTLE_AUTHORIZATION_TYPEHASH, negotiationId, buyerCommitment, sellerCommitment, round, round
                )
            )
        );
    }

    /// @notice The hash stored for a negotiation's admission policy.
    function admissionPolicyHash(ReputationGate.Policy calldata policy) public pure returns (bytes32) {
        return keccak256(abi.encode(policy));
    }

    function getNegotiation(uint256 negotiationId) external view returns (Negotiation memory) {
        return _negotiations[negotiationId];
    }

    /// @dev The last round both sides have committed, and each side's
    ///      commitment for it. Sides are never more than one round apart, so a
    ///      side that is ahead has its commitment for that round in `_previous`.
    function _settleablePair(uint256 negotiationId, Negotiation storage n)
        private
        view
        returns (bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 round)
    {
        round = n.buyerCommitIndex < n.sellerCommitIndex ? n.buyerCommitIndex : n.sellerCommitIndex;
        buyerCommitment = n.buyerCommitIndex == round ? n.buyerCommitment : _previous[negotiationId].buyer;
        sellerCommitment = n.sellerCommitIndex == round ? n.sellerCommitment : _previous[negotiationId].seller;
    }

    function _load(uint256 negotiationId) private view returns (Negotiation storage n) {
        n = _negotiations[negotiationId];
        if (n.status == Status.None) revert UnknownNegotiation(negotiationId);
    }
}
