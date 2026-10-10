import fs from "fs";
import { Contract, JsonRpcProvider, Wallet, ZeroHash } from "ethers";
import { chainFees } from "../agents/sealed/fees";

/**
 * Seeds the reputation of an agent that lives outside this repository (for
 * example the seller in kasbsquall/sealed-seller-agent), with the same three
 * demo reviewers and the same labelling as scripts/seed-demo.ts: these reviews
 * are ours, written so the agent clears the demo admission policy, and say
 * nothing about how it behaves.
 *
 *   EXTERNAL_AGENT_ID=2126 npx tsx scripts/seed-external.ts
 */
const RPC = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const VALUES = [450, 440, 460, 430, 450];
const REVIEWERS = ["reviewerA", "reviewerB", "reviewerC"] as const;
const ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
];

async function main() {
  const agentId = BigInt(process.env.EXTERNAL_AGENT_ID ?? "");
  const state = JSON.parse(fs.readFileSync("deployments/monadTestnet.json", "utf8"));
  const keys = JSON.parse(fs.readFileSync(".demo-wallets.json", "utf8"));
  const provider = new JsonRpcProvider(RPC);
  const record: string[] = [];
  for (let i = 0; i < VALUES.length; i++) {
    const reviewer = new Wallet(keys[REVIEWERS[i % REVIEWERS.length]], provider);
    const registry = new Contract(state.registries.reputation, ABI, reviewer);
    const tx = await registry.giveFeedback(agentId, VALUES[i], 2, "", "", "", "", ZeroHash, await chainFees(provider));
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`feedback ${i + 1} failed: ${tx.hash}`);
    console.log(`feedback ${i + 1} (${VALUES[i]}) ${tx.hash}`);
    record.push(tx.hash);
  }
  state.external = { ...(state.external ?? {}), [agentId.toString()]: { seededFeedback: record } };
  fs.writeFileSync("deployments/monadTestnet.json", JSON.stringify(state, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
