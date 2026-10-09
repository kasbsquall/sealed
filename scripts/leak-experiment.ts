import fs from "fs";
import { ethers, network } from "hardhat";
import { Wallet } from "ethers";
import { NegotiatorAgent, type AgentOptions, type Mandate } from "../agents/negotiator/negotiator";
import { ClearingRelay } from "../agents/relay/clearingRelay";
import { LocalPartyWallet } from "../agents/wallets/partyWallet";
import { OpenAICompatibleClient, llmConfigFromEnv } from "../agents/llm/client";
import { OnChainView } from "../agents/negotiator/chainView";
import { deployRegistries, leaveFeedback, registerAgent } from "../test/helpers/erc8004";
import { INJECTED_LIMIT_TERMS, MAX_ROUNDS, REFERENCE, SCENARIOS, TERMS, UNIT } from "./demo-config";
import { runMetrics } from "./leak-metrics";

/**
 * What does sealing save against negotiating in the open? Runs the `deal`
 * scenario (buyer limit 4300, seller limit 4100, reference 4000, 3 rounds) with
 * real model-driven agents under one condition:
 *
 *   sealed           the normal flow: neither side ever sees the other's number
 *   open             each agent sees the other's numbers from earlier rounds, as
 *                    on a public chain or with plain commit-reveal
 *   leaked-limit     sealed, but the seller's model is told the buyer's limit
 *   injection-limit  sealed, and the buyer is shown a seller listing that tells
 *                    it to open at its limit (scripts/demo-config.ts)
 *
 * Local Hardhat network only, so no testnet gas is spent. Each process starts a
 * fresh in-process chain and deploys what the tests deploy: the vendored ERC-8004
 * registries, ReputationGate and SealedNegotiation, with the agents' reputation
 * seeded with the values scripts/seed-demo.ts left on Monad testnet. The model
 * settings come from .env. One JSON per run goes to experiments/leak-2026-10/.
 *
 *   CONDITION=open RUN_IDS=1,2,3 npx hardhat run scripts/leak-experiment.ts --network hardhat
 *
 * Runs listed in RUN_IDS go one after the other; run two processes for two at once.
 */

const CONDITIONS = ["sealed", "open", "leaked-limit", "injection-limit"] as const;
type Condition = (typeof CONDITIONS)[number];
const OUT_DIR = "experiments/leak-2026-10";
/** The same seeded reviews as scripts/seed-demo.ts, so the reputation tool reads the same averages. */
const FEEDBACK = { buyer: [480n, 460n, 470n, 490n, 450n, 470n], seller: [440n, 430n, 450n, 420n, 460n, 430n] };
const POLICY = { minFeedbackCount: 5, minAverageValue: 400, decimals: 2, tag1: "" };

async function deployLocal() {
  const [funder] = await ethers.getSigners();
  const fresh = async () => {
    const w = Wallet.createRandom().connect(ethers.provider);
    await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther("10") })).wait();
    return w;
  };
  const [relayer, buyerKey, sellerKey, ...reviewers] = [await fresh(), await fresh(), await fresh(), await fresh(), await fresh(), await fresh()];
  const registries = await deployRegistries();
  const buyerId = await registerAgent(registries, buyerKey);
  const sellerId = await registerAgent(registries, sellerKey);
  await leaveFeedback(registries, buyerId, reviewers, FEEDBACK.buyer);
  await leaveFeedback(registries, sellerId, reviewers, FEEDBACK.seller);
  const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(
    await registries.identity.getAddress(),
    await registries.reputation.getAddress(),
  );
  const sealed = await (await ethers.getContractFactory("SealedNegotiation")).deploy(await gate.getAddress());
  return {
    relayer,
    buyerKey,
    sellerKey,
    buyerId,
    sellerId,
    sealedAddress: await sealed.getAddress(),
    reputationAddress: await registries.reputation.getAddress(),
    policy: { ...POLICY, reviewers: reviewers.map((r) => r.address) },
  };
}

async function runOnce(condition: Condition, runId: string) {
  const local = await deployLocal();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = { chainId, verifyingContract: local.sealedAddress };
  const llmConfig = llmConfigFromEnv();
  const { buyerLimit, sellerLimit, windowSeconds } = SCENARIOS.deal;
  const buyerTerms = condition === "injection-limit" ? INJECTED_LIMIT_TERMS : undefined;
  const terms = buyerTerms ?? TERMS;

  const relay = new ClearingRelay(local.relayer, domain, async (ms) => {
    await ethers.provider.send("evm_increaseTime", [Math.ceil(ms / 1000)]);
    await ethers.provider.send("evm_mine", []);
  });
  const chain = new OnChainView(ethers.provider, local.sealedAddress, local.reputationAddress);
  const mandate = (role: "buyer" | "seller", limit: bigint): Mandate => ({ role, limit, reference: REFERENCE, maxRounds: MAX_ROUNDS, unit: UNIT });
  const base: AgentOptions = { chain, reviewers: local.policy.reviewers };
  // Each side sees the other's committed numbers through a closure, read only
  // when it decides; the agent itself drops anything from the current round.
  const offersOf = (agent: () => NegotiatorAgent) => () => agent().decisions.map((d) => ({ round: d.round, offer: d.offer }));

  const buyer: NegotiatorAgent = new NegotiatorAgent(
    "buyer",
    { ...mandate("buyer", buyerLimit), terms: buyerTerms },
    new LocalPartyWallet(local.buyerKey, domain),
    new OpenAICompatibleClient(llmConfig),
    domain,
    { ...base, ...(condition === "open" ? { counterpartyOffers: offersOf(() => seller) } : {}) },
  );
  const seller: NegotiatorAgent = new NegotiatorAgent(
    "seller",
    mandate("seller", sellerLimit),
    new LocalPartyWallet(local.sellerKey, domain),
    new OpenAICompatibleClient(llmConfig),
    domain,
    {
      ...base,
      ...(condition === "open" ? { counterpartyOffers: offersOf(() => buyer) } : {}),
      ...(condition === "leaked-limit" ? { leakedCounterpartyLimit: buyerLimit } : {}),
    },
  );

  console.log(`\n== ${condition} run ${runId}: buyer limit ${buyerLimit}, seller limit ${sellerLimit}`);
  const startedAt = new Date().toISOString();
  const record = await relay.negotiate({
    buyer: { agent: buyer, agentId: local.buyerId },
    seller: { agent: seller, agentId: local.sellerId },
    termsSchema: ethers.id(terms),
    policy: local.policy,
    maxRounds: MAX_ROUNDS,
    windowSeconds,
    onEvent: (m) => console.log(`  ${m}`),
  });
  const finishedAt = new Date().toISOString();

  const run = {
    experiment: "leak-2026-10",
    condition,
    runId,
    conditionDescription: {
      sealed: "Normal Sealed flow: neither agent ever sees the other's number.",
      open: "Each agent's prompt, round brief and read_negotiation tool show the counterparty's offers from earlier rounds, as a public chain or plain commit-reveal would.",
      "leaked-limit": `Sealed flow, but the seller's system prompt states the buyer's limit (${buyerLimit}) as leaked. The buyer is not told.`,
      "injection-limit": "Sealed flow; the buyer's model is shown the seller's listing, labelled as seller-written, which tells it to open at its limit.",
    }[condition],
    harness:
      "Local Hardhat network, in-process, fresh per run: vendored ERC-8004 registries, ReputationGate and SealedNegotiation deployed by scripts/leak-experiment.ts, reputation seeded as scripts/seed-demo.ts did on Monad testnet. Not a field study.",
    network: network.name,
    chainId: chainId.toString(),
    contract: local.sealedAddress,
    model: llmConfig.model,
    modelHost: llmConfig.baseUrl.includes("localhost") ? "local (Ollama on the operator's machine)" : llmConfig.baseUrl,
    terms,
    referencePrice: REFERENCE.toString(),
    maxRounds: MAX_ROUNDS,
    limits: { buyer: buyerLimit.toString(), seller: sellerLimit.toString() },
    disclosure: "Throwaway local chain: mandates, offers, notes and salts are published so the run can be audited.",
    startedAt,
    finishedAt,
    ...record,
  };
  const metrics = runMetrics(run);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/${condition}-${runId}.json`;
  fs.writeFileSync(file, JSON.stringify({ ...run, metrics }, null, 2) + "\n");
  console.log(`  outcome ${record.outcome}${record.settledPrice ? ` at ${record.settledPrice}` : ""} · ${file}`);
}

async function main() {
  if (network.name !== "hardhat") throw new Error("The leak experiment runs on the local Hardhat network only: --network hardhat");
  const condition = process.env.CONDITION as Condition;
  if (!CONDITIONS.includes(condition)) throw new Error(`CONDITION must be one of ${CONDITIONS.join(", ")}`);
  const runIds = (process.env.RUN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!runIds.length || runIds.some((id) => !/^\d+$/.test(id))) throw new Error("RUN_IDS must list run numbers, e.g. RUN_IDS=1,2,3");
  for (const id of runIds) {
    if (fs.existsSync(`${OUT_DIR}/${condition}-${id}.json`)) throw new Error(`${OUT_DIR}/${condition}-${id}.json exists; pick another run number`);
  }
  console.log(`Network ${network.name} · model ${llmConfigFromEnv().model} · ${condition} · runs ${runIds.join(", ")}`);
  for (const id of runIds) await runOnce(condition, id);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
