// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title SealedTestUSD
/// @author Sealed
/// @notice A test dollar for the Sealed demo on Monad testnet. It has no value
///         and anyone can mint it: it exists so that a settlement can move a
///         price and a fee on-chain without a real stablecoin. 6 decimals, like
///         USDC, so prices convert the same way.
contract SealedTestUSD is ERC20 {
    /// @notice The most one `mint` call creates: 1,000,000 test dollars.
    uint256 public constant MINT_CAP = 1_000_000e6;

    error OverMintCap(uint256 amount);

    constructor() ERC20("Sealed Test USD (no value)", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test dollars to `to`. Open to anyone, capped per call.
    function mint(address to, uint256 amount) external {
        if (amount > MINT_CAP) revert OverMintCap(amount);
        _mint(to, amount);
    }
}
