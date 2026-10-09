import { ethers, network } from "hardhat";
import { REGISTRIES } from "./registries";

/**
 * Calls the live ERC-8004 registries through the exact interfaces Sealed
 * compiles against. If an interface drifts from the deployed contract, a call
 * here reverts without data and the script fails.
 *
 *   npx hardhat run scripts/check-registries.ts --network monadTestnet
 */
async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const registries = REGISTRIES[chainId];
  if (!registries) throw new Error(`No ERC-8004 registries recorded for chain ${chainId}.`);

  const identity = await ethers.getContractAt("contracts/interfaces/IIdentityRegistry.sol:IIdentityRegistry", registries.identity);
  const reputation = await ethers.getContractAt("IReputationRegistry", registries.reputation);

  console.log(`Network   ${network.name} (${chainId})`);

  const agentId = 1n;
  console.log(`getAgentWallet(${agentId})  ${await identity.getAgentWallet(agentId)}`);

  const [count, value, decimals] = await reputation.getSummary(agentId, [ethers.ZeroAddress], "", "");
  console.log(`getSummary(${agentId}, [0x0])  count=${count} value=${value} decimals=${decimals}`);

  // The registry must refuse an empty reviewer set; ReputationGate relies on
  // that being the only way to ask.
  try {
    await reputation.getSummary(agentId, [], "", "");
    throw new Error("getSummary accepted an empty reviewer set; ERC-8004 behaviour changed");
  } catch (error: any) {
    if (!String(error.message).includes("clientAddresses required")) throw error;
    console.log(`getSummary(${agentId}, [])  reverts "clientAddresses required", as expected`);
  }

  console.log("Interfaces match the deployed registries.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
