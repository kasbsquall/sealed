import fs from "fs";
import { ethers, network } from "hardhat";
import { Contract, Wallet } from "ethers";
import { NegotiatorAgent, type Mandate } from "../agents/negotiator/negotiator";
import { ClearingRelay } from "../agents/relay/clearingRelay";
import { LocalPartyWallet } from "../agents/wallets/partyWallet";
import { OpenAICompatibleClient, llmConfigFromEnv } from "../agents/llm/client";
import { OnChainView } from "../agents/negotiator/chainView";
import { admissionPolicyHash } from "../agents/sealed/policy";
import { chainFees } from "../agents/sealed/fees";
import { MAX_ROUNDS, REFERENCE, SCENARIOS, TERMS, UNIT } from "./demo-config";

/**
 * The demo deal on SealedNegotiationV3, where settlement pays. Same agents,
 * limits and model as run-demo.ts; the difference is that both agents sign the
 * payment terms before the negotiation opens, and the settle transaction moves
 * the price from the buyer's escrow to the seller, less the 0.25% fee.
 *
 * The price unit is US cents per 1,000 calls. SCALE pays for 1,000,000 calls
 * (1,000 units) in a 6-decimal test dollar: 4190 settles as 41,900 tUSD.
 *
 *   npx hardhat run scripts/run-paid.ts --network monadTestnet
 */
const CALLS = 1_000_000n;
const SCALE = 10_000n * (CALLS / 1_000n);
const FLOAT = 100_000n * 1_000_000n;

const USD_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];
const ESCROW_ABI = [
  "function depositFor(address token, address account, uint256 amount)",
  "function escrowOf(address token, address account) view returns (uint256)",
];

async function main() {
  const state = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const v3 = state.contractsV3;
  if (!v3) throw new Error(`No contractsV3 in deployments/${network.name}.json; run scripts/deploy-v3.ts first.`);
  const keys = JSON.parse(fs.readFileSync(".demo-wallets.json", "utf8"));
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY missing; the relay pays gas with it.");

  const domain = { chainId: BigInt(state.chainId), verifyingContract: v3.SealedNegotiationV3 };
  const relayer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, ethers.provider);
  const buyerKey = new Wallet(keys.buyer, ethers.provider);
  const sellerKey = new Wallet(keys.seller, ethers.provider);
  const usd = new Contract(v3.SealedTestUSD, USD_ABI, buyerKey);
  const escrow = new Contract(v3.SealedNegotiationV3, ESCROW_ABI, buyerKey);
  const token: string = v3.SealedTestUSD;

  // The buyer funds its own escrow once: a float that covers any price it could
  // agree to, so the deposit says nothing about this negotiation's limit.
  const transactions: Record<string, string> = {};
  if ((await escrow.escrowOf(token, buyerKey.address)) < FLOAT) {
    const steps: [string, (fees: object) => Promise<any>][] = [
      ["mint", (f) => usd.mint(buyerKey.address, FLOAT, f)],
      ["approve", (f) => usd.approve(v3.SealedNegotiationV3, FLOAT, f)],
      ["depositFor", (f) => escrow.depositFor(token, buyerKey.address, FLOAT, f)],
    ];
    for (const [name, send] of steps) {
      const tx = await send(await chainFees(ethers.provider));
      await tx.wait();
      transactions[name] = tx.hash;
      console.log(`  ${name} ${tx.hash}`);
    }
  }

  const balances = async () => ({
    buyerEscrow: (await escrow.escrowOf(token, buyerKey.address)).toString(),
    seller: (await usd.balanceOf(sellerKey.address)).toString(),
    treasury: (await usd.balanceOf(v3.treasury)).toString(),
  });
  const before = await balances();

  const llmConfig = llmConfigFromEnv();
  const relay = new ClearingRelay(relayer, domain);
  const chain = new OnChainView(ethers.provider, v3.SealedNegotiationV3, state.registries.reputation);
  const reviewers: string[] = state.policy.reviewers;
  const scenario = SCENARIOS.deal;
  const paidTerms = { termsSchema: ethers.id(TERMS), token, scale: SCALE, policyHash: admissionPolicyHash(state.policy) };
  const mandate = (role: "buyer" | "seller", limit: bigint): Mandate => ({
    role,
    limit,
    reference: REFERENCE,
    maxRounds: MAX_ROUNDS,
    unit: UNIT,
  });
  const options = {
    chain,
    reviewers,
    paidTerms,
    dealFeedback: { provider: ethers.provider, reputationRegistry: state.registries.reputation },
  };
  const buyer = new NegotiatorAgent("buyer", mandate("buyer", scenario.buyerLimit), new LocalPartyWallet(buyerKey, domain), new OpenAICompatibleClient(llmConfig), domain, options);
  const seller = new NegotiatorAgent("seller", mandate("seller", scenario.sellerLimit), new LocalPartyWallet(sellerKey, domain), new OpenAICompatibleClient(llmConfig), domain, options);

  console.log(`Network ${network.name} · model ${llmConfig.model} · contract ${v3.SealedNegotiationV3}`);
  const startedAt = new Date().toISOString();
  const record = await relay.negotiate({
    buyer: { agent: buyer, agentId: BigInt(state.agents.buyer.agentId) },
    seller: { agent: seller, agentId: BigInt(state.agents.seller.agentId) },
    termsSchema: ethers.id(TERMS),
    policy: state.policy,
    maxRounds: MAX_ROUNDS,
    windowSeconds: scenario.windowSeconds,
    payment: { token, scale: SCALE },
    onEvent: (m) => console.log(`  ${m}`),
  });
  const after = await balances();

  const transcript = {
    scenario: "deal-paid",
    network: network.name,
    chainId: state.chainId,
    contract: v3.SealedNegotiationV3,
    token,
    tokenNote: "SealedTestUSD (tUSD): a test dollar with no value, 6 decimals, minted freely for the demo.",
    treasury: v3.treasury,
    relay: relayer.address,
    model: llmConfig.model,
    terms: TERMS,
    termsSchema: ethers.id(TERMS),
    payment: {
      unit: UNIT,
      calls: CALLS.toString(),
      scale: SCALE.toString(),
      rule: "amount = settledPrice * scale in tUSD base units; the seller receives amount minus 0.25%, the treasury the 0.25%",
    },
    escrowFunding: transactions,
    referencePrice: REFERENCE.toString(),
    admissionPolicy: state.policy,
    disclosure: "Demo only: mandates, offers, stances and salts are published so every on-chain hash can be recomputed. A real agent never discloses them.",
    agents: {
      buyer: { agentId: state.agents.buyer.agentId, wallet: buyerKey.address, limit: scenario.buyerLimit.toString() },
      seller: { agentId: state.agents.seller.agentId, wallet: sellerKey.address, limit: scenario.sellerLimit.toString() },
    },
    balances: { before, after },
    startedAt,
    finishedAt: new Date().toISOString(),
    ...record,
  };
  fs.mkdirSync("demo-runs", { recursive: true });
  const file = `demo-runs/${network.name}-v3-deal-paid-${record.negotiationId}.json`;
  fs.writeFileSync(file, JSON.stringify(transcript, null, 2) + "\n");
  console.log(`  outcome ${record.outcome}${record.settledPrice ? ` at ${record.settledPrice}` : ""} · ${file}`);
  console.log(`  balances before ${JSON.stringify(before)}\n  balances after  ${JSON.stringify(after)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
