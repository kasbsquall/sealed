import fs from "fs";
import { ethers, network } from "hardhat";
import { fees } from "./fees";

/**
 * Puts the gate's refusal on-chain, so a judge can open it in the explorer.
 *
 * The smoke test only proved the refusal with an eth_call. This sends the same
 * createNegotiation as a real transaction, with a fixed gas limit so the node
 * does not refuse it at estimation, and records the reverted hash. It costs the
 * gas limit once (Monad charges the limit) and opens nothing.
 *
 *   npx hardhat run scripts/gate-refusal.ts --network monadTestnet
 */

const TERMS = "Demo: newcomer agent tries to open a negotiation";
/** Above what a successful createNegotiation with two gate checks uses on Monad. */
const GAS_LIMIT = 400_000n;

async function main() {
  const file = `deployments/${network.name}.json`;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (state.gateRefusal?.tx) {
    console.log(`already recorded: ${state.gateRefusal.tx}`);
    return;
  }
  const [relayer] = await ethers.getSigners();
  const sealed = await ethers.getContractAt("SealedNegotiation", state.contracts.SealedNegotiation, relayer);
  const gate = await ethers.getContractAt("ReputationGate", state.contracts.ReputationGate);

  const newcomer = state.agents.newcomer;
  const seller = state.agents.seller;
  if (await gate.clears(BigInt(newcomer.agentId), state.policy)) throw new Error("the newcomer clears the policy; nothing to refuse");

  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
  const tx = await sealed.createNegotiation(
    BigInt(newcomer.agentId),
    newcomer.wallet,
    BigInt(seller.agentId),
    seller.wallet,
    deadline,
    ethers.id(TERMS),
    state.policy,
    { ...(await fees()), gasLimit: GAS_LIMIT },
  );
  let receipt = null;
  for (let i = 0; i < 60 && !receipt; i++) {
    receipt = await ethers.provider.getTransactionReceipt(tx.hash);
    if (!receipt) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!receipt) throw new Error(`no receipt for ${tx.hash}`);
  if (receipt.status !== 0) throw new Error(`expected a revert, got success: ${tx.hash}`);

  state.gateRefusal = {
    note: "createNegotiation sent as a real transaction with the newcomer as buyer; the gate reverted it with NotAdmitted.",
    agentId: newcomer.agentId,
    tx: tx.hash,
    block: receipt.blockNumber,
  };
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  console.log(`gate refused agent #${newcomer.agentId} on-chain: ${tx.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
