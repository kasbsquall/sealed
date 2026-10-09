// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIdentityRegistry
/// @notice Minimal view surface of the canonical ERC-8004 Identity Registry.
/// @dev Sealed never deploys its own identity registry. It reads the singleton
///      already deployed on Base (see docs/ADDRESSES.md). The registry is an
///      ERC-721: an agent is a token, `agentId` is its tokenId.
///      Signatures checked against IdentityRegistryUpgradeable at commit b9e466c
///      and against the live proxy on Base Sepolia.
interface IIdentityRegistry {
    /// @notice Owner of the agent token.
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice The wallet the agent signs with.
    /// @dev Set to the registering address at `register()`, changeable only with
    ///      a signature from the new wallet. Stored as 20 packed bytes under the
    ///      reserved metadata key "agentWallet"; this getter decodes it. Returns
    ///      the zero address when unset.
    function getAgentWallet(uint256 agentId) external view returns (address);
}
