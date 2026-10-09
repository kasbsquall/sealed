// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReputationRegistry
/// @notice Minimal view surface of the canonical ERC-8004 Reputation Registry.
/// @dev ERC-8004 deliberately stores no aggregate "score": it stores individual
///      feedback entries and exposes a filtered aggregation via getSummary().
///      Any notion of "trustworthy enough" is therefore a policy decision made
///      by the consumer, not by the standard. Sealed makes that policy explicit
///      and on-chain in ReputationGate.
///      Signature checked against ReputationRegistryUpgradeable at commit
///      b9e466c and against the live proxy on Base Sepolia.
interface IReputationRegistry {
    /// @notice Aggregated feedback for an agent from a given set of clients.
    /// @param agentId         Agent being queried.
    /// @param clientAddresses Reviewers whose feedback counts. Must be non-empty:
    ///                        the registry reverts with "clientAddresses required"
    ///                        otherwise, so a consumer always has to say whose
    ///                        opinion it trusts.
    /// @param tag1            Restrict to this primary tag (empty = all).
    /// @param tag2            Restrict to this secondary tag (empty = all).
    /// @return count                Non-revoked entries matched. Revoked feedback
    ///                              is always excluded.
    /// @return summaryValue         Average of the matched values.
    /// @return summaryValueDecimals Fixed-point decimals of `summaryValue` (the
    ///                              most frequent decimals among matched entries).
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}
