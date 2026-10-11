import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ethers, network } from "hardhat";
import { fees } from "./fees";

/**
 * Deploys SealedNegotiationV3 next to the v2 ReputationGate (it keeps no state,
 * so v3 reuses it) and a test dollar to pay with. The treasury that receives the
 * 0.25% fee is TREASURY, or the deployer when unset.
 *
 * On Monad testnet it records the addresses under `contractsV3` in
 * deployments/monadTestnet.json; on the local network it only prints gas.
 */
async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const [deployer] = await ethers.getSigners();
  const file = `deployments/${network.name}.json`;
  const recorded = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;

  let gate: string | undefined = recorded?.contracts?.ReputationGate;
  if (!gate) {
    if (network.name !== "hardhat") throw new Error(`No ReputationGate recorded in ${file}`);
    gate = await (await (await ethers.getContractFactory("ReputationGate")).deploy(deployer.address, deployer.address)).getAddress();
  }
  const treasury = process.env.TREASURY ?? deployer.address;

  console.log(`Network   ${network.name} (${chainId})`);
  console.log(`Deployer  ${deployer.address}`);
  console.log(`Balance   ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} MON`);
  console.log(`Gate      ${gate} (reused)`);
  console.log(`Treasury  ${treasury}`);

  const usd = await (await ethers.getContractFactory("SealedTestUSD")).deploy(await fees());
  await usd.waitForDeployment();
  const usdTx = await usd.deploymentTransaction()!.wait();
  console.log(`SealedTestUSD        ${await usd.getAddress()}  tx ${usdTx!.hash}  gas ${usdTx!.gasUsed}`);

  const sealed = await (await ethers.getContractFactory("SealedNegotiationV3")).deploy(gate, treasury, await fees());
  await sealed.waitForDeployment();
  const sealedTx = await sealed.deploymentTransaction()!.wait();
  console.log(`SealedNegotiationV3  ${await sealed.getAddress()}  tx ${sealedTx!.hash}  gas ${sealedTx!.gasUsed}`);

  if (!recorded || network.name === "hardhat") return;
  const updated = {
    ...recorded,
    contractsV3: {
      ReputationGate: gate,
      SealedNegotiationV3: await sealed.getAddress(),
      SealedTestUSD: await usd.getAddress(),
      treasury,
    },
    transactionsV3: { SealedTestUSD: usdTx!.hash, SealedNegotiationV3: sealedTx!.hash },
  };
  writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`Recorded under contractsV3 in ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
