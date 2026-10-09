import fs from "fs";
import { ethers, network } from "hardhat";
import { Wallet } from "ethers";
import { NegotiatorAgent, type Mandate } from "../agents/negotiator/negotiator";
import { ClearingRelay } from "../agents/relay/clearingRelay";
import { LocalPartyWallet } from "../agents/wallets/partyWallet";
import { OpenAICompatibleClient, llmConfigFromEnv } from "../agents/llm/client";
import { OnChainView } from "../agents/negotiator/chainView";
import { MAX_ROUNDS, REFERENCE, SCENARIOS, TERMS, UNIT, type ScenarioName } from "./demo-config";

/**
 * Runs the two demo negotiations on a live network with real LLM agents:
 *
 *   deal     the mandates overlap, so the agents can find a price both accept
 *   no-deal  the mandates cannot overlap, so the negotiation expires and neither
 *            number ever reaches the chain
 *
 * Each agent decides with its own model call and only its own mandate. The
 * transcript, written to demo-runs/, publishes the mandates, offers and salts
 * on purpose so anyone can recompute every on-chain hash. A real agent would
 * never disclose any of it.
 *
 *   npx hardhat run scripts/run-demo.ts --network monadTestnet
 *   DEMO_SCENARIOS=deal npx hardhat run ...     (run only one)
 */


async function main() {
  const state = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const keys = JSON.parse(fs.readFileSync(".demo-wallets.json", "utf8"));
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY missing; the relay pays gas with it.");

  const domain = { chainId: BigInt(state.chainId), verifyingContract: state.contracts.SealedNegotiation };
  const llmConfig = llmConfigFromEnv();
  const relayer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, ethers.provider);
  // On a local fork the clock only moves when blocks are mined, so waiting for a
  // deadline means jumping time instead of sleeping.
  const relay =
    network.name === "hardhat"
      ? new ClearingRelay(relayer, domain, async (ms) => {
          await ethers.provider.send("evm_increaseTime", [Math.ceil(ms / 1000)]);
          await ethers.provider.send("evm_mine", []);
        })
      : new ClearingRelay(relayer, domain);
  // Public, read-only: what the agents' read tools see on-chain.
  const chain = new OnChainView(ethers.provider, state.contracts.SealedNegotiation, state.registries.reputation);
  const reviewers: string[] = state.policy.reviewers;
  const selected = (process.env.DEMO_SCENARIOS?.split(",") ?? Object.keys(SCENARIOS)) as ScenarioName[];

  fs.mkdirSync("demo-runs", { recursive: true });
  console.log(`Network ${network.name} · model ${llmConfig.model} at ${llmConfig.baseUrl}`);

  for (const name of selected) {
    const scenario = SCENARIOS[name];
    const buyerTerms = "buyerTerms" in scenario ? scenario.buyerTerms : undefined;
    // What the contract hashes is the listing as published: with the injection, if any.
    const terms = buyerTerms ?? TERMS;
    const mandate = (role: "buyer" | "seller", limit: bigint): Mandate => ({
      role,
      limit,
      reference: REFERENCE,
      maxRounds: MAX_ROUNDS,
      unit: UNIT,
    });
    // Each agent gets its own client: nothing is shared between the two sides.
    const buyer = new NegotiatorAgent(
      "buyer",
      { ...mandate("buyer", scenario.buyerLimit), terms: buyerTerms },
      new LocalPartyWallet(new Wallet(keys.buyer, ethers.provider), domain),
      new OpenAICompatibleClient(llmConfig),
      domain,
      { chain, reviewers, dealFeedback: { provider: ethers.provider, reputationRegistry: state.registries.reputation } },
    );
    const seller = new NegotiatorAgent(
      "seller",
      mandate("seller", scenario.sellerLimit),
      new LocalPartyWallet(new Wallet(keys.seller, ethers.provider), domain),
      new OpenAICompatibleClient(llmConfig),
      domain,
      { chain, reviewers, dealFeedback: { provider: ethers.provider, reputationRegistry: state.registries.reputation } },
    );

    console.log(`\n== ${name}: buyer limit ${scenario.buyerLimit}, seller limit ${scenario.sellerLimit}`);
    const startedAt = new Date().toISOString();
    const record = await relay.negotiate({
      buyer: { agent: buyer, agentId: BigInt(state.agents.buyer.agentId) },
      seller: { agent: seller, agentId: BigInt(state.agents.seller.agentId) },
      termsSchema: ethers.id(terms),
      policy: state.policy,
      maxRounds: MAX_ROUNDS,
      windowSeconds: scenario.windowSeconds,
      onEvent: (m) => console.log(`  ${m}`),
    });
    for (const r of record.rounds) {
      console.log(`  round ${r.round}: crossed ${r.crossed}
    buyer  ${r.buyer.stance}: ${r.buyer.explanation}
    seller ${r.seller.stance}: ${r.seller.explanation}`);
    }

    const transcript = {
      scenario: name,
      network: network.name,
      chainId: state.chainId,
      contract: state.contracts.SealedNegotiation,
      relay: relayer.address,
      model: llmConfig.model,
      modelHost: llmConfig.baseUrl.includes("localhost") ? "local (Ollama on the operator's machine)" : llmConfig.baseUrl,
      terms,
      termsSchema: ethers.id(terms),
      ...(buyerTerms ? { buyerShownTerms: "The buyer's model was shown the terms above, labelled as written by the seller. The seller's model was not shown terms." } : {}),
      referencePrice: REFERENCE.toString(),
      admissionPolicy: state.policy,
      disclosure: "Demo only: mandates, offers, stances and salts are published so every on-chain hash can be recomputed. A real agent never discloses them.",
      agents: {
        buyer: { agentId: state.agents.buyer.agentId, wallet: buyer.wallet.address, limit: scenario.buyerLimit.toString() },
        seller: { agentId: state.agents.seller.agentId, wallet: seller.wallet.address, limit: scenario.sellerLimit.toString() },
      },
      startedAt,
      finishedAt: new Date().toISOString(),
      ...record,
    };
    const file = `demo-runs/${network.name}-${name}-${record.negotiationId}.json`;
    fs.writeFileSync(file, JSON.stringify(transcript, null, 2) + "\n");
    console.log(`  outcome ${record.outcome}${record.settledPrice ? ` at ${record.settledPrice}` : ""} · ${file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
