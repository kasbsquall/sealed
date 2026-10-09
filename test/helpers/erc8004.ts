import { ethers } from "hardhat";
import type { Signer } from "ethers";

/**
 * Deploys the real ERC-8004 registries (vendored in contracts/vendor/erc8004)
 * the same way they are deployed on Base: an ERC-1967 proxy that starts on a
 * minimal UUPS implementation and is upgraded to the registry. Mirrors the
 * helpers in the official erc-8004-contracts test suite.
 */

const PROXY = "contracts/vendor/erc8004/ERC1967Proxy.sol:ERC1967Proxy";

async function deployUpgradedProxy(implementation: string, initCalldata: string, minimalInitArg: string) {
  const minimal = await (await ethers.getContractFactory("HardhatMinimalUUPS")).deploy();
  const minimalInit = minimal.interface.encodeFunctionData("initialize", [minimalInitArg]);
  const proxy = await (await ethers.getContractFactory(PROXY)).deploy(await minimal.getAddress(), minimalInit);
  const proxyAddress = await proxy.getAddress();

  const impl = await (await ethers.getContractFactory(implementation)).deploy();
  const asMinimal = await ethers.getContractAt("HardhatMinimalUUPS", proxyAddress);
  await asMinimal.upgradeToAndCall(await impl.getAddress(), initCalldata);
  return proxyAddress;
}

export async function deployRegistries() {
  const identityFactory = await ethers.getContractFactory("IdentityRegistryUpgradeable");
  const identityAddress = await deployUpgradedProxy(
    "IdentityRegistryUpgradeable",
    identityFactory.interface.encodeFunctionData("initialize"),
    ethers.ZeroAddress,
  );

  const reputationFactory = await ethers.getContractFactory("ReputationRegistryUpgradeable");
  const reputationAddress = await deployUpgradedProxy(
    "ReputationRegistryUpgradeable",
    reputationFactory.interface.encodeFunctionData("initialize", [identityAddress]),
    identityAddress,
  );

  return {
    identity: await ethers.getContractAt("IdentityRegistryUpgradeable", identityAddress),
    reputation: await ethers.getContractAt("ReputationRegistryUpgradeable", reputationAddress),
  };
}

type Registries = Awaited<ReturnType<typeof deployRegistries>>;

/**
 * Registers an agent from `wallet`. ERC-8004 sets the agent's `agentWallet` to
 * the registering address, so this is also the address that signs for it.
 */
export async function registerAgent(registries: Registries, wallet: Signer): Promise<bigint> {
  const identity = registries.identity.connect(wallet);
  const agentId = await identity["register()"].staticCall();
  await identity["register()"]();
  return agentId;
}

/**
 * Leaves one feedback entry per value, spread round-robin across `reviewers`.
 * Values are fixed point with `decimals` decimals, as ERC-8004 stores them.
 */
export async function leaveFeedback(
  registries: Registries,
  agentId: bigint,
  reviewers: Signer[],
  values: bigint[],
  decimals = 2,
  tag1 = "",
) {
  for (let i = 0; i < values.length; i++) {
    const reviewer = reviewers[i % reviewers.length];
    await registries.reputation
      .connect(reviewer)
      .giveFeedback(agentId, values[i], decimals, tag1, "", "", "", ethers.ZeroHash);
  }
}

export const repeat = (value: bigint, times: number) => Array.from({ length: times }, () => value);
