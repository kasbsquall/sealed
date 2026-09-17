// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test doubles for the canonical ERC-8004 registries.
/// @dev Used only by the test suite and by local development. On Monad, Sealed
///      points at the real singletons listed in docs/ADDRESSES.md.
contract MockIdentityRegistry {
    mapping(uint256 => address) public owners;
    mapping(uint256 => mapping(string => bytes)) internal _metadata;

    function register(uint256 agentId, address wallet) external {
        owners[agentId] = wallet;
        _metadata[agentId]["agentWallet"] = abi.encode(bytes32(uint256(uint160(wallet))));
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        return _metadata[agentId][key];
    }
}

contract MockReputationRegistry {
    struct Summary {
        uint64 count;
        int128 averageValue;
        uint8 valueDecimals;
    }

    mapping(uint256 => Summary) public summaries;

    function setSummary(uint256 agentId, uint64 count, int128 averageValue, uint8 valueDecimals) external {
        summaries[agentId] = Summary(count, averageValue, valueDecimals);
    }

    function getSummary(uint256 agentId, address[] calldata, string calldata, string calldata, bool)
        external
        view
        returns (uint64, int128, uint8)
    {
        Summary memory s = summaries[agentId];
        return (s.count, s.averageValue, s.valueDecimals);
    }
}
