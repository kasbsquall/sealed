import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Wallet } from "ethers";
import { deployRegistries, leaveFeedback, registerAgent, repeat } from "./helpers/erc8004";
import { NegotiatorAgent, type AgentOptions, type Mandate } from "../agents/negotiator/negotiator";
import { ClearingRelay } from "../agents/relay/clearingRelay";
import { LocalPartyWallet } from "../agents/wallets/partyWallet";
import type { ChatMessage, ChatReply, LlmClient } from "../agents/llm/client";
import { admissionPolicyHash } from "../agents/sealed/policy";

/** Submits a scripted offer each round, so the test exercises the code around the model. */
class ScriptedModel implements LlmClient {
  readonly model = "scripted";
  constructor(private readonly offers: number[]) {}
  async chat(messages: ChatMessage[]): Promise<ChatReply> {
    const brief = messages.find((m) => m.role === "user" && /^Round \d+/.test(m.content ?? ""));
    const round = Number(/^Round (\d+)/.exec((brief?.content as string) ?? "Round 1")![1]);
    const offer = this.offers[Math.min(round - 1, this.offers.length - 1)];
    return {
      content: null,
      toolCalls: [{ id: "s", name: "submit_offer", arguments: JSON.stringify({ offer, stance: "concede", note: "" }) }],
    };
  }
}

// Same scale as the demo: a price in US cents per 1,000 calls, for 10,000
// thousand-call units, in a 6-decimal token. 4190 -> 41,900 tUSD.
const SCALE = 10_000n * 1_000n;
const TERMS = ethers.id("paid test terms");

async function setup() {
  const [funder, ...rest] = await ethers.getSigners();
  const reviewers = rest.slice(0, 3);
  const fresh = async () => {
    const w = Wallet.createRandom().connect(ethers.provider);
    await funder.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
    return w;
  };
  const [buyerKey, sellerKey, relayerKey, treasury] = [await fresh(), await fresh(), await fresh(), await fresh()];

  const registries = await deployRegistries();
  const buyerId = await registerAgent(registries, buyerKey);
  const sellerId = await registerAgent(registries, sellerKey);
  await leaveFeedback(registries, buyerId, reviewers, repeat(470n, 6));
  await leaveFeedback(registries, sellerId, reviewers, repeat(440n, 6));

  const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(
    await registries.identity.getAddress(),
    await registries.reputation.getAddress(),
  );
  const sealed = await (await ethers.getContractFactory("SealedNegotiationV3")).deploy(await gate.getAddress(), treasury.address);
  const usd = await (await ethers.getContractFactory("SealedTestUSD")).deploy();
  const token = await usd.getAddress();
  const domain = { chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await sealed.getAddress() };
  const policy = {
    reviewers: await Promise.all(reviewers.map((r) => r.getAddress())),
    minFeedbackCount: 5,
    minAverageValue: 400,
    decimals: 2,
    tag1: "",
  };
  const paidTerms = { termsSchema: TERMS, token, scale: SCALE, policyHash: admissionPolicyHash(policy) };

  // The buyer's escrow: anyone may fund it, here the funder does.
  const float = 100_000n * 1_000_000n;
  await usd.connect(funder).mint(funder.address, float);
  await usd.connect(funder).approve(domain.verifyingContract, float);
  await sealed.connect(funder).depositFor(token, buyerKey.address, float);

  const relay = new ClearingRelay(relayerKey, domain, async (ms) => {
    await time.increase(Math.ceil(ms / 1000));
  });

  const agent = (role: "buyer" | "seller", limit: number, offers: number[], extra: AgentOptions = {}) => {
    const mandate: Mandate = { role, limit: BigInt(limit), reference: 4000n, maxRounds: 3, unit: "US cents per 1,000 calls" };
    const key = role === "buyer" ? buyerKey : sellerKey;
    return new NegotiatorAgent(role, mandate, new LocalPartyWallet(key, domain), new ScriptedModel(offers), domain, {
      paidTerms,
      ...extra,
    });
  };

  const negotiate = (buyer: NegotiatorAgent, seller: NegotiatorAgent, payment = { token, scale: SCALE }) =>
    relay.negotiate({
      buyer: { agent: buyer, agentId: buyerId },
      seller: { agent: seller, agentId: sellerId },
      termsSchema: TERMS,
      policy,
      maxRounds: 3,
      windowSeconds: 600,
      payment,
    });

  return { sealed, usd, token, agent, negotiate, buyerKey, sellerKey, treasury, float, paidTerms };
}

describe("Clearing relay against SealedNegotiationV3 (paid settlement)", () => {
  it("collects both consents, settles, and moves the price and the fee in the same transaction", async () => {
    const { sealed, usd, token, agent, negotiate, buyerKey, sellerKey, treasury, float } = await setup();
    const record = await negotiate(agent("buyer", 4300, [4000, 4280]), agent("seller", 4100, [4400, 4100]));

    expect(record.outcome).to.equal("settled");
    expect(record.settledPrice).to.equal("4190");
    const amount = 4190n * SCALE;
    const fee = (amount * 25n) / 10_000n;
    expect(record.payment).to.include({ token, scale: SCALE.toString(), amount: amount.toString(), fee: fee.toString() });
    expect(record.payment!.consent.buyer).to.match(/^0x[0-9a-f]{130}$/i);

    expect(await usd.balanceOf(sellerKey.address)).to.equal(amount - fee);
    expect(await usd.balanceOf(treasury.address)).to.equal(fee);
    expect(await sealed.escrowOf(token, buyerKey.address)).to.equal(float - amount);
    expect(await sealed.openAsBuyer(buyerKey.address)).to.equal(0n);
  });

  it("does not open a negotiation when a party's own terms differ from what it is asked to sign", async () => {
    const { agent, negotiate, paidTerms } = await setup();
    const seller = agent("seller", 4100, [4400, 4100], { paidTerms: { ...paidTerms, scale: SCALE * 2n } });
    let failure: unknown;
    try {
      await negotiate(agent("buyer", 4300, [4000, 4280]), seller);
    } catch (e) {
      failure = e;
    }
    expect(String(failure)).to.match(/scale|terms/i);
  });

  it("leaves the escrow whole when the offers never cross", async () => {
    const { sealed, token, agent, negotiate, buyerKey, float } = await setup();
    const record = await negotiate(agent("buyer", 3900, [3700, 3800, 3900]), agent("seller", 4100, [4400, 4200, 4100]));

    expect(record.outcome).to.equal("expired");
    expect(record.payment?.amount).to.equal(undefined);
    expect(await sealed.escrowOf(token, buyerKey.address)).to.equal(float);
  });
});
