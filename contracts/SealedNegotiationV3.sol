// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReputationGate} from "./ReputationGate.sol";

/// @title SealedNegotiationV3
/// @author Sealed
/// @notice The sealed negotiation of SealedNegotiation (v2), with the agreed
///         price paid in the same transaction that settles it.
///
/// @dev v2 is deployed and verified as it is, so this is a separate contract
///      rather than an edit of SealedNegotiation.sol. The negotiation itself is
///      unchanged: salted, domain-separated commitments per round, a round
///      frozen once both sides commit it, one atomic settlement with both
///      offers and both EIP-712 authorizations, the midpoint price, and an
///      expiry that publishes nothing. What v3 adds:
///
///      (1) Payment at settlement. The buyer keeps a float in escrow here. When
///          a negotiation settles, `price * scale` token units move from the
///          buyer's escrow to the seller, less a fee of FEE_BPS that goes to
///          the treasury. `scale` converts the negotiated unit into token base
///          units for the whole deal, and is part of the signed terms.
///
///          Why escrow and not an allowance or a deposit per negotiation: a
///          deposit sized to one negotiation, or an approval for exactly the
///          buyer's limit, would publish the limit before the first round. A
///          float the buyer tops up independently of any one deal does not.
///          And while the buyer has a paid negotiation open, its escrow cannot
///          be withdrawn: otherwise a buyer could learn that a round crossed,
///          empty its escrow, and make the settlement revert with both offers
///          in its calldata. The float is shared, not reserved per negotiation:
///          with two open, the first to settle draws first, and the second can
///          revert with InsufficientEscrow. A seller that wants certainty reads
///          escrowOf against the most it could be paid before it consents.
///
///      (2) Both parties sign the terms. A paid negotiation opens only with an
///          EIP-712 OpenNegotiation signature from each wallet (or with that
///          party as the caller), covering both agents, the deadline, the terms,
///          the hash of the admission policy and the payment terms. In v2 the
///          creator chose the policy alone; here neither side is admitted, or
///          has its escrow locked, under terms it did not sign. A pair of
///          consents opens one negotiation (`consentUsed`), and the deadline is
///          at most MAX_WINDOW away, so the lock on a float has a ceiling.
///
///      (3) Commit by signature. `commitOfferBySig` lets anyone, typically the
///          relay, submit a party's commitment with that party's EIP-712
///          signature over (negotiationId, commitment, commitIndex). An agent
///          without gas can negotiate; the index makes each signature single-use.
///
///      The relay is still trusted with confidentiality: it sees both offers of
///      each round to tell the two sides whether they cross. It cannot forge a
///      deal or move funds: payment happens only inside `settle`, which needs
///      both authorizations over the exact committed pair.
contract SealedNegotiationV3 is EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        None,
        Open,
        Locked,
        Settled,
        Expired
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
        bytes32 termsSchema;
        bytes32 policyHash;
    }

    struct PreviousCommitments {
        bytes32 buyer;
        bytes32 seller;
    }

    struct Reveal {
        uint256 offer;
        bytes32 salt;
    }

    /// @notice How the agreed price is paid.
    /// @param token The ERC-20 the buyer's escrow is held in. A standard token:
    ///        fee-on-transfer and rebasing tokens are not supported.
    /// @param scale Token base units per unit of price for the whole deal. With
    ///        a price in US cents per 1,000 calls, a 6-decimal dollar token and a
    ///        deal of 1,000,000 calls: 10,000 units per cent times 1,000 lots.
    struct Payment {
        address token;
        uint256 scale;
    }

    /// @notice The parties of a negotiation, grouped to keep the call readable.
    struct Parties {
        uint256 buyerAgentId;
        address buyerWallet;
        uint256 sellerAgentId;
        address sellerWallet;
    }

    // ---------------------------------------------------------------------
    // Constants and storage
    // ---------------------------------------------------------------------

    /// @notice Sealed's fee, in basis points of the amount paid. Taken from the
    ///         seller's proceeds, so the buyer pays exactly the agreed price.
    uint256 public constant FEE_BPS = 25;
    /// @notice The furthest a deadline may be set. A buyer's float stays locked
    ///         while it has a negotiation open, so the lock has a ceiling.
    uint256 public constant MAX_WINDOW = 7 days;

    bytes32 private constant SETTLE_AUTHORIZATION_TYPEHASH = keccak256(
        "SettleAuthorization(uint256 negotiationId,bytes32 buyerCommitment,bytes32 sellerCommitment,uint32 buyerCommitIndex,uint32 sellerCommitIndex)"
    );
    bytes32 private constant OPEN_NEGOTIATION_TYPEHASH = keccak256(
        "OpenNegotiation(uint256 buyerAgentId,address buyerWallet,uint256 sellerAgentId,address sellerWallet,uint64 deadline,bytes32 termsSchema,bytes32 policyHash,address token,uint256 scale)"
    );
    bytes32 private constant COMMIT_TYPEHASH =
        keccak256("Commit(uint256 negotiationId,bytes32 commitment,uint32 commitIndex)");

    ReputationGate public immutable gate;
    /// @notice Receives the fee of every settled negotiation.
    address public immutable treasury;

    uint256 public negotiationCount;
    mapping(uint256 => Negotiation) private _negotiations;
    mapping(uint256 => PreviousCommitments) private _previous;
    mapping(uint256 => Payment) private _payments;
    /// @notice OpenNegotiation digests already used. A pair of consents opens
    ///         one negotiation; replaying the calldata cannot open more.
    mapping(bytes32 => bool) public consentUsed;

    /// @notice A buyer's float, by token. Paid from at settlement.
    mapping(address token => mapping(address account => uint256)) public escrowOf;
    /// @notice Paid negotiations open with this wallet as the buyer. While it is
    ///         above zero the wallet cannot withdraw.
    mapping(address account => uint256) public openAsBuyer;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event NegotiationCreated(
        uint256 indexed negotiationId,
        address indexed buyerWallet,
        address indexed sellerWallet,
        uint256 buyerAgentId,
        uint256 sellerAgentId,
        uint64 deadline,
        bytes32 termsSchema,
        bytes32 policyHash,
        address token,
        uint256 scale
    );
    event OfferCommitted(uint256 indexed negotiationId, address indexed party, uint32 commitIndex);
    event NegotiationLocked(uint256 indexed negotiationId);
    event NegotiationSettled(uint256 indexed negotiationId, uint256 price);
    event NegotiationExpired(uint256 indexed negotiationId);
    event Paid(
        uint256 indexed negotiationId, address indexed token, address buyer, address seller, uint256 amount, uint256 fee
    );
    event Deposited(address indexed token, address indexed account, address from, uint256 amount);
    event Withdrawn(address indexed token, address indexed account, uint256 amount);

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
    error BadConsent(address party);
    error BadCommitSignature(address party);
    error IncompatibleOffers();
    error AlreadyCommitted(uint32 commitIndex);
    error BadPaymentTerms();
    error InsufficientEscrow();
    error EscrowLocked(uint256 openNegotiations);
    error ConsentUsed();
    error DeadlineTooFar();
    error ZeroTreasury();

    // ---------------------------------------------------------------------

    constructor(address _gate, address _treasury) EIP712("Sealed", "1") {
        if (_treasury == address(0)) revert ZeroTreasury();
        gate = ReputationGate(_gate);
        treasury = _treasury;
    }

    // ---------------------------------------------------------------------
    // Escrow
    // ---------------------------------------------------------------------

    /// @notice Add to `account`'s float. Anyone can fund any account.
    /// @dev Size the float independently of any one negotiation: its amount is
    ///      public, and a float equal to a limit would publish that limit.
    function depositFor(address token, address account, uint256 amount) external {
        escrowOf[token][account] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, account, msg.sender, amount);
    }

    /// @notice Take back part of your float. Only with no paid negotiation open
    ///         as the buyer: see (1) in the contract notes.
    function withdraw(address token, uint256 amount) external {
        uint256 open = openAsBuyer[msg.sender];
        if (open != 0) revert EscrowLocked(open);
        uint256 available = escrowOf[token][msg.sender];
        if (available < amount) revert InsufficientEscrow();
        escrowOf[token][msg.sender] = available - amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(token, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Negotiation
    // ---------------------------------------------------------------------

    /// @notice Open a paid negotiation between two agents that both clear
    ///         `policy`, on terms both of them signed.
    /// @param buyerConsent OpenNegotiation signature from the buyer's wallet;
    ///        ignored, and may be empty, when the buyer is the caller.
    /// @param sellerConsent The same from the seller's wallet.
    function createNegotiation(
        Parties calldata parties,
        uint64 deadline,
        bytes32 termsSchema,
        ReputationGate.Policy calldata policy,
        Payment calldata payment,
        bytes calldata buyerConsent,
        bytes calldata sellerConsent
    ) external returns (uint256 negotiationId) {
        if (parties.buyerWallet == parties.sellerWallet) revert SameParty();
        if (deadline <= block.timestamp + 1 minutes) revert DeadlineTooSoon();
        if (deadline > block.timestamp + MAX_WINDOW) revert DeadlineTooFar();
        if (payment.token == address(0) || payment.scale == 0) revert BadPaymentTerms();

        bytes32 policyHash = admissionPolicyHash(policy);
        bytes32 consentDigest = openNegotiationDigest(parties, deadline, termsSchema, policyHash, payment);
        if (consentUsed[consentDigest]) revert ConsentUsed();
        consentUsed[consentDigest] = true;
        _requireConsent(parties.buyerWallet, consentDigest, buyerConsent);
        _requireConsent(parties.sellerWallet, consentDigest, sellerConsent);

        gate.requireAdmitted(parties.buyerAgentId, parties.buyerWallet, policy);
        gate.requireAdmitted(parties.sellerAgentId, parties.sellerWallet, policy);

        negotiationId = ++negotiationCount;
        _negotiations[negotiationId] = Negotiation({
            buyerWallet: parties.buyerWallet,
            sellerWallet: parties.sellerWallet,
            buyerAgentId: parties.buyerAgentId,
            sellerAgentId: parties.sellerAgentId,
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
        _payments[negotiationId] = payment;
        openAsBuyer[parties.buyerWallet] += 1;

        emit NegotiationCreated(
            negotiationId,
            parties.buyerWallet,
            parties.sellerWallet,
            parties.buyerAgentId,
            parties.sellerAgentId,
            deadline,
            termsSchema,
            policyHash,
            payment.token,
            payment.scale
        );
    }

    /// @notice Commit a position for the caller's next round. Same rules as v2:
    ///         a side is at most one round ahead, and a round both sides have
    ///         committed stays settleable until both commit the next one.
    function commitOffer(uint256 negotiationId, bytes32 commitment) external {
        _commit(negotiationId, msg.sender, commitment);
    }

    /// @notice Submit `party`'s commitment for its next round with its Commit
    ///         signature. The round index is in the signed message, so a
    ///         signature can be used once, for the round it was made for.
    function commitOfferBySig(uint256 negotiationId, address party, bytes32 commitment, bytes calldata signature)
        external
    {
        Negotiation storage n = _load(negotiationId);
        uint32 next;
        if (party == n.buyerWallet) next = n.buyerCommitIndex + 1;
        else if (party == n.sellerWallet) next = n.sellerCommitIndex + 1;
        else revert NotAParty(party);
        if (ECDSA.recover(commitDigest(negotiationId, commitment, next), signature) != party) {
            revert BadCommitSignature(party);
        }
        _commit(negotiationId, party, commitment);
    }

    /// @notice Settle the last complete round and pay the agreed price.
    /// @dev Checks and price exactly as in v2. Then `price * scale` moves from
    ///      the buyer's escrow: the seller receives it less the fee, the
    ///      treasury receives the fee. All in this one transaction.
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

        (bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 round) = _settleablePair(negotiationId, n);
        if (commitmentHash(negotiationId, n.buyerWallet, round, buyerReveal.offer, buyerReveal.salt) != buyerCommitment) {
            revert CommitmentMismatch(n.buyerWallet);
        }
        if (
            commitmentHash(negotiationId, n.sellerWallet, round, sellerReveal.offer, sellerReveal.salt)
                != sellerCommitment
        ) revert CommitmentMismatch(n.sellerWallet);

        bytes32 digest = settleAuthorizationDigest(negotiationId);
        if (ECDSA.recover(digest, buyerAuthorization) != n.buyerWallet) revert BadAuthorization(n.buyerWallet);
        if (ECDSA.recover(digest, sellerAuthorization) != n.sellerWallet) revert BadAuthorization(n.sellerWallet);

        if (buyerReveal.offer < sellerReveal.offer) revert IncompatibleOffers();
        price = sellerReveal.offer + (buyerReveal.offer - sellerReveal.offer) / 2;

        n.status = Status.Settled;
        n.settledPrice = price;
        openAsBuyer[n.buyerWallet] -= 1;
        emit NegotiationSettled(negotiationId, price);

        _pay(negotiationId, n, price);
    }

    /// @notice Close a negotiation past its deadline. Nothing is revealed and
    ///         nothing is paid; the buyer's escrow is no longer held for it.
    function expire(uint256 negotiationId) external {
        Negotiation storage n = _load(negotiationId);
        if (n.status != Status.Open && n.status != Status.Locked) {
            revert WrongStatus(n.status, Status.Locked);
        }
        if (block.timestamp < n.deadline) revert DeadlineNotPassed();

        n.status = Status.Expired;
        openAsBuyer[n.buyerWallet] -= 1;
        emit NegotiationExpired(negotiationId);
    }

    // ---------------------------------------------------------------------
    // Views and helpers
    // ---------------------------------------------------------------------

    /// @notice The hash an agent commits. Identical to v2.
    function commitmentHash(uint256 negotiationId, address party, uint32 commitIndex, uint256 offer, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(_domainSeparatorV4(), negotiationId, party, commitIndex, offer, salt));
    }

    /// @notice EIP-712 digest each agent signs to authorize settlement. Identical to v2.
    function settleAuthorizationDigest(uint256 negotiationId) public view returns (bytes32) {
        (bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 round) =
            _settleablePair(negotiationId, _negotiations[negotiationId]);
        return _hashTypedDataV4(
            keccak256(
                abi.encode(SETTLE_AUTHORIZATION_TYPEHASH, negotiationId, buyerCommitment, sellerCommitment, round, round)
            )
        );
    }

    /// @notice EIP-712 digest both parties sign to open a paid negotiation.
    function openNegotiationDigest(
        Parties calldata parties,
        uint64 deadline,
        bytes32 termsSchema,
        bytes32 policyHash,
        Payment calldata payment
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OPEN_NEGOTIATION_TYPEHASH,
                    parties.buyerAgentId,
                    parties.buyerWallet,
                    parties.sellerAgentId,
                    parties.sellerWallet,
                    deadline,
                    termsSchema,
                    policyHash,
                    payment.token,
                    payment.scale
                )
            )
        );
    }

    /// @notice EIP-712 digest a party signs to have its commitment submitted for it.
    function commitDigest(uint256 negotiationId, bytes32 commitment, uint32 commitIndex) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(COMMIT_TYPEHASH, negotiationId, commitment, commitIndex)));
    }

    function admissionPolicyHash(ReputationGate.Policy calldata policy) public pure returns (bytes32) {
        return keccak256(abi.encode(policy));
    }

    function getNegotiation(uint256 negotiationId) external view returns (Negotiation memory) {
        return _negotiations[negotiationId];
    }

    function getPayment(uint256 negotiationId) external view returns (Payment memory) {
        return _payments[negotiationId];
    }

    function _commit(uint256 negotiationId, address party, bytes32 commitment) private {
        Negotiation storage n = _load(negotiationId);
        if (n.status != Status.Open && n.status != Status.Locked) {
            revert WrongStatus(n.status, Status.Open);
        }
        if (block.timestamp >= n.deadline) revert DeadlinePassed();

        if (party == n.buyerWallet) {
            if (n.buyerCommitIndex > n.sellerCommitIndex) revert AlreadyCommitted(n.buyerCommitIndex);
            _previous[negotiationId].buyer = n.buyerCommitment;
            n.buyerCommitment = commitment;
            n.buyerCommitIndex += 1;
            emit OfferCommitted(negotiationId, party, n.buyerCommitIndex);
        } else if (party == n.sellerWallet) {
            if (n.sellerCommitIndex > n.buyerCommitIndex) revert AlreadyCommitted(n.sellerCommitIndex);
            _previous[negotiationId].seller = n.sellerCommitment;
            n.sellerCommitment = commitment;
            n.sellerCommitIndex += 1;
            emit OfferCommitted(negotiationId, party, n.sellerCommitIndex);
        } else {
            revert NotAParty(party);
        }

        if (n.status == Status.Open && n.buyerCommitIndex != 0 && n.sellerCommitIndex != 0) {
            n.status = Status.Locked;
            emit NegotiationLocked(negotiationId);
        }
    }

    /// @dev Effects before the two transfers: status, settled price, open count
    ///      and escrow are all written first.
    function _pay(uint256 negotiationId, Negotiation storage n, uint256 price) private {
        Payment memory payment = _payments[negotiationId];
        uint256 amount = price * payment.scale;
        uint256 available = escrowOf[payment.token][n.buyerWallet];
        if (available < amount) revert InsufficientEscrow();
        escrowOf[payment.token][n.buyerWallet] = available - amount;

        // Rounded up, so splitting a deal into dust cannot skip the fee.
        uint256 fee = (amount * FEE_BPS + 9_999) / 10_000;
        IERC20(payment.token).safeTransfer(n.sellerWallet, amount - fee);
        if (fee != 0) IERC20(payment.token).safeTransfer(treasury, fee);
        emit Paid(negotiationId, payment.token, n.buyerWallet, n.sellerWallet, amount, fee);
    }

    function _requireConsent(address wallet, bytes32 digest, bytes calldata signature) private view {
        if (msg.sender == wallet) return;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != wallet) revert BadConsent(wallet);
    }

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
