import "dotenv/config";
import "@nomicfoundation/hardhat-toolbox";
import type { HardhatUserConfig } from "hardhat/config";

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    // FORK_MONAD=1 runs the local network as a fork of Monad testnet, with the
    // live ERC-8004 registries, to rehearse scripts and measure gas before
    // spending testnet MON.
    hardhat: process.env.FORK_MONAD
      ? {
          forking: { url: process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz" },
          chainId: 10143,
          // Monad's base fee floor; the local default would understate fees.
          initialBaseFeePerGas: 100_000_000_000,
        }
      : {},
    monadTestnet: {
      url: process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts,
    },
  },
  // Sourcify needs no API key, so anyone can reproduce the verification.
  sourcify: { enabled: true },
};

export default config;
