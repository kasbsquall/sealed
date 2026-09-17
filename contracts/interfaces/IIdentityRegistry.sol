// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIdentityRegistry
/// @notice Minimal view surface of the canonical ERC-8004 Identity Registry.
/// @dev Sealed never deploys its own identity registry. It reads the singleton
///      already deployed on Monad (see docs/ADDRESSES.md). The registry is an
///      ERC-721: an agent is a token, `agentId` is its tokenId.
interface IIdentityRegistry {
    /// @notice Owner of the agent token.
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice Arbitrary on-chain metadata attached to an agent.
    /// @dev ERC-8004 initialises the key "agentWallet" at registration time.
    ///      That is the address an agent signs with, which may differ from the
    ///      token owner. Sealed binds negotiations to this wallet.
    function getMetadata(uint256 agentId, string calldata key)
        external
        view
        returns (bytes memory);
}
