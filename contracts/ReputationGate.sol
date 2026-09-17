// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";

/// @title ReputationGate
/// @author Sealed
/// @notice Decides whether an agent is allowed to enter a negotiation, based on
///         its ERC-8004 identity and reputation, without disclosing its history.
///
/// @dev Why this contract exists.
///
///      ERC-8004's Reputation Registry has no `getScore()`. It stores individual
///      feedback entries and exposes `getSummary()`. Turning that into a yes/no
///      admission decision is a policy choice, and hiding that choice inside an
///      off-chain service would defeat the purpose of an on-chain trust layer.
///      So the policy lives here, it is readable by anyone, and it is attached
///      to each negotiation at creation time.
///
///      The privacy property: this contract answers "does agent X clear the
///      bar?" and nothing else. It never returns, emits, or stores the agent's
///      feedback history, its average, or its counterparties. A counterparty
///      learns one bit, not a dossier.
contract ReputationGate {
    /// @notice Admission policy. Immutable once a negotiation references it.
    /// @param minFeedbackCount Minimum number of feedback entries on record.
    ///        Guards against a fresh address with one flattering review.
    /// @param minAverageValue Minimum average feedback value, in `decimals`
    ///        fixed point, as returned by the registry.
    /// @param decimals Fixed-point decimals `minAverageValue` is expressed in.
    /// @param tag1 Optional ERC-8004 tag to scope the query (empty = all).
    struct Policy {
        uint64 minFeedbackCount;
        int128 minAverageValue;
        uint8 decimals;
        string tag1;
    }

    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;

    /// @notice Metadata key defined by ERC-8004 for an agent's signing wallet.
    string internal constant AGENT_WALLET_KEY = "agentWallet";

    error AgentWalletMismatch(uint256 agentId, address expected);
    error PolicyDecimalsMismatch(uint8 policyDecimals, uint8 registryDecimals);

    constructor(address _identityRegistry, address _reputationRegistry) {
        identityRegistry = IIdentityRegistry(_identityRegistry);
        reputationRegistry = IReputationRegistry(_reputationRegistry);
    }

    /// @notice True if `wallet` is the ERC-8004 registered wallet of `agentId`.
    /// @dev Prevents an unrelated address from borrowing someone else's
    ///      reputation by simply quoting their agentId.
    function isAgentWallet(uint256 agentId, address wallet) public view returns (bool) {
        bytes memory raw = identityRegistry.getMetadata(agentId, AGENT_WALLET_KEY);
        if (raw.length != 32) return false;
        return address(uint160(uint256(abi.decode(raw, (bytes32))))) == wallet;
    }

    /// @notice Whether `agentId` clears `policy`. One bit out, nothing else.
    function clears(uint256 agentId, Policy calldata policy) public view returns (bool) {
        address[] memory anyClient = new address[](0);

        (uint64 count, int128 average, uint8 registryDecimals) = reputationRegistry.getSummary(
            agentId,
            anyClient,
            policy.tag1,
            "",
            false // revoked feedback never counts towards admission
        );

        if (count < policy.minFeedbackCount) return false;
        if (registryDecimals != policy.decimals) {
            revert PolicyDecimalsMismatch(policy.decimals, registryDecimals);
        }
        return average >= policy.minAverageValue;
    }

    /// @notice Reverts unless `wallet` owns `agentId` and `agentId` clears `policy`.
    /// @dev Called by SealedNegotiation before a negotiation can be created.
    function requireAdmitted(uint256 agentId, address wallet, Policy calldata policy) external view {
        if (!isAgentWallet(agentId, wallet)) revert AgentWalletMismatch(agentId, wallet);
        if (!clears(agentId, policy)) revert NotAdmitted(agentId);
    }

    error NotAdmitted(uint256 agentId);
}
