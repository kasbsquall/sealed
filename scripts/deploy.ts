import { ethers, network } from "hardhat";
import { REGISTRIES } from "./registries";

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const registries = REGISTRIES[chainId];
  if (!registries) {
    throw new Error(`No ERC-8004 registries recorded for chain ${chainId}. See docs/ADDRESSES.md.`);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Network   ${network.name} (${chainId})`);
  console.log(`Deployer  ${deployer.address}`);
  console.log(`Balance   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} MON`);

  const gate = await (
    await ethers.getContractFactory("ReputationGate")
  ).deploy(registries.identity, registries.reputation);
  await gate.waitForDeployment();
  console.log(`ReputationGate      ${await gate.getAddress()}  tx ${gate.deploymentTransaction()?.hash}`);

  const sealed = await (await ethers.getContractFactory("SealedNegotiation")).deploy(await gate.getAddress());
  await sealed.waitForDeployment();
  console.log(`SealedNegotiation   ${await sealed.getAddress()}  tx ${sealed.deploymentTransaction()?.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
