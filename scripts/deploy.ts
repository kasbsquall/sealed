import { ethers, network } from "hardhat";

/** Canonical ERC-8004 singletons. See docs/ADDRESSES.md. */
const REGISTRIES: Record<number, { identity: string; reputation: string }> = {
  10143: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
  143: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
};

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
  console.log(`ReputationGate      ${await gate.getAddress()}`);

  const sealed = await (await ethers.getContractFactory("SealedNegotiation")).deploy(await gate.getAddress());
  await sealed.waitForDeployment();
  console.log(`SealedNegotiation   ${await sealed.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
