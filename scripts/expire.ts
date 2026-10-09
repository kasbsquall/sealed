import fs from "fs";
import { ethers, network } from "hardhat";
import { fees } from "./fees";

/**
 * Expires a negotiation whose deadline has passed. Anyone may call expire; it
 * discloses nothing.
 *
 *   NEGOTIATION_ID=2 npx hardhat run scripts/expire.ts --network monadTestnet
 */
async function main() {
  const id = BigInt(process.env.NEGOTIATION_ID ?? "0");
  if (id === 0n) throw new Error("Set NEGOTIATION_ID.");
  const state = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const sealed = await ethers.getContractAt("SealedNegotiation", state.contracts.SealedNegotiation);
  const n = await sealed.getNegotiation(id);
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  if (now < n.deadline) throw new Error(`Deadline not reached: ${n.deadline - now}s left.`);
  const tx = await sealed.expire(id, await fees());
  await tx.wait();
  console.log(`Expired negotiation ${id}: ${tx.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
