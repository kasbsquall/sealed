// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReputationRegistry
/// @notice Minimal view surface of the canonical ERC-8004 Reputation Registry.
/// @dev ERC-8004 deliberately stores no aggregate "score": it stores individual
///      feedback entries and exposes a filtered aggregation via getSummary().
///      Any notion of "trustworthy enough" is therefore a policy decision made
///      by the consumer, not by the standard. Sealed makes that policy explicit
///      and on-chain in ReputationGate.
interface IReputationRegistry {
    /// @notice Aggregated feedback for an agent, optionally filtered.
    /// @param agentId    Agent being queried.
    /// @param clients    Restrict to feedback from these addresses (empty = all).
    /// @param tag1       Restrict to this primary tag (empty = all).
    /// @param tag2       Restrict to this secondary tag (empty = all).
    /// @param includeRevoked Whether revoked feedback counts.
    /// @return count     Number of feedback entries matched.
    /// @return averageValue Average of the matched values.
    /// @return valueDecimals Fixed-point decimals of `averageValue`.
    function getSummary(
        uint256 agentId,
        address[] calldata clients,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    ) external view returns (uint64 count, int128 averageValue, uint8 valueDecimals);
}
