import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Wallet } from "ethers";
import { deployRegistries, leaveFeedback, registerAgent, repeat } from "./helpers/erc8004";
import { NegotiatorAgent, type Mandate, type Reveal } from "../agents/negotiator/negotiator";
import { ClearingRelay } from "../agents/relay/clearingRelay";
import { HttpParty, serveParty, serverUrl } from "../agents/relay/party";
import { LocalPartyWallet } from "../agents/wallets/partyWallet";
import type { ChatMessage, ChatReply, LlmClient } from "../agents/llm/client";
import { OnChainView } from "../agents/negotiator/chainView";

/**
 * A model that answers from a script, so the tests exercise the code around it.
 * Each round it submits that round's scripted offer straight away, and keeps
 * submitting the same number if the agent rejects it.
 */
class ScriptedModel implements LlmClient {
  readonly model = "scripted";
  constructor(private readonly offers: (number | "garbage")[]) {}
  async chat(messages: ChatMessage[]): Promise<ChatReply> {
    const brief = messages.find((m) => m.role === "user" && /^Round \d+/.test(m.content ?? ""));
    const round = Number(/^Round (\d+)/.exec((brief?.content as string) ?? "Round 1")![1]);
    const next = this.offers[Math.min(round - 1, this.offers.length - 1)];
    if (next === "garbage") throw new Error("model returned garbage");
    const stance = round === 1 ? "open-with-room" : "concede";
    return submit({ offer: next, stance, note: "" });
  }
}

const submit = (args: object, id = "s"): ChatReply => ({
  content: null,
  toolCalls: [{ id, name: "submit_offer", arguments: JSON.stringify(args) }],
});

/** A model that plays a fixed sequence of replies and records what it was shown. */
class ToolUsingModel implements LlmClient {
  readonly model = "tool-using";
  readonly seen: ChatMessage[][] = [];
  private turn = 0;
  constructor(private readonly replies: ChatReply[]) {}
  async chat(messages: ChatMessage[]): Promise<ChatReply> {
    this.seen.push([...messages]);
    return this.replies[Math.min(this.turn++, this.replies.length - 1)];
  }
}

const calls = (...names: [string, object][]): ChatReply => ({
  content: null,
  toolCalls: names.map(([name, args], i) => ({ id: `c${i}`, name, arguments: JSON.stringify(args) })),
});

const UNIT = "US cents per unit";

async function setup() {
  const [funder, ...rest] = await ethers.getSigners();
  const reviewers = rest.slice(0, 3);
  const fresh = async () => {
    const w = Wallet.createRandom().connect(ethers.provider);
    await funder.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
    return w;
  };
  const [buyerKey, sellerKey, relayerKey] = [await fresh(), await fresh(), await fresh()];

  const registries = await deployRegistries();
  const buyerId = await registerAgent(registries, buyerKey);
  const sellerId = await registerAgent(registries, sellerKey);
  await leaveFeedback(registries, buyerId, reviewers, repeat(470n, 6));
  await leaveFeedback(registries, sellerId, reviewers, repeat(440n, 6));

  const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(
    await registries.identity.getAddress(),
    await registries.reputation.getAddress(),
  );
  const sealed = await (await ethers.getContractFactory("SealedNegotiation")).deploy(await gate.getAddress());
  const domain = { chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await sealed.getAddress() };
  const policy = {
    reviewers: await Promise.all(reviewers.map((r) => r.getAddress())),
    minFeedbackCount: 5,
    minAverageValue: 400,
    decimals: 2,
    tag1: "",
  };
  const relay = new ClearingRelay(relayerKey, domain, async (ms) => {
    await time.increase(Math.ceil(ms / 1000));
  });

  const chain = new OnChainView(ethers.provider, await sealed.getAddress(), await registries.reputation.getAddress());
  const agent = (role: "buyer" | "seller", limit: number, offers: (number | "garbage")[] | LlmClient) => {
    const mandate: Mandate = { role, limit: BigInt(limit), reference: 4000n, maxRounds: 3, unit: UNIT };
    const key = role === "buyer" ? buyerKey : sellerKey;
    const model = Array.isArray(offers) ? new ScriptedModel(offers) : offers;
    return new NegotiatorAgent(role, mandate, new LocalPartyWallet(key, domain), model, domain, { chain, reviewers: policy.reviewers });
  };

  const negotiate = (buyer: NegotiatorAgent | HttpParty, seller: NegotiatorAgent | HttpParty) =>
    relay.negotiate({
      buyer: { agent: buyer, agentId: buyerId },
      seller: { agent: seller, agentId: sellerId },
      termsSchema: ethers.id("test terms"),
      policy,
      maxRounds: 3,
      windowSeconds: 600,
    });

  return { sealed, agent, negotiate, domain };
}

describe("Negotiator agents and the clearing relay", () => {
  it("settles at the midpoint in the first round where the numbers cross", async () => {
    const { sealed, agent, negotiate } = await setup();
    const record = await negotiate(agent("buyer", 4500, [3800, 4200]), agent("seller", 3900, [4600, 4100]));

    expect(record.outcome).to.equal("settled");
    expect(record.rounds.map((r) => r.crossed)).to.deep.equal([false, true]);
    expect(record.settledPrice).to.equal("4150");
    expect((await sealed.getNegotiation(BigInt(record.negotiationId))).settledPrice).to.equal(4150n);
  });

  it("settles the same way when each agent is reached over HTTP and the relay holds no party key", async () => {
    const { sealed, agent, negotiate } = await setup();
    const servers = await Promise.all([
      serveParty(agent("buyer", 4500, [3800, 4200])),
      serveParty(agent("seller", 3900, [4600, 4100])),
    ]);
    try {
      const [buyer, seller] = await Promise.all(servers.map((s) => HttpParty.connect(serverUrl(s))));
      const record = await negotiate(buyer, seller);
      expect(record.outcome).to.equal("settled");
      expect(record.rounds.map((r) => r.crossed)).to.deep.equal([false, true]);
      expect((await sealed.getNegotiation(BigInt(record.negotiationId))).settledPrice).to.equal(4150n);
    } finally {
      servers.forEach((s) => s.close());
    }
  });

  it("never commits past the principal's limit, whatever the model says", async () => {
    const { agent, negotiate } = await setup();
    const record = await negotiate(agent("buyer", 4000, [9999]), agent("seller", 3900, [3950]));

    const buyer = record.rounds[0].buyer;
    expect(buyer.offer).to.equal("4000");
    expect(buyer.proposedOffer).to.equal("9999");
    expect(buyer.correction).to.equal("limit");
    expect(record.outcome).to.equal("settled");
  });

  it("never walks back a concession made in an earlier round", async () => {
    const { agent, negotiate } = await setup();
    const record = await negotiate(agent("buyer", 4500, [3700, 3500, 3600]), agent("seller", 4400, [4800, 4700, 4600]));

    expect(record.rounds[1].buyer.offer).to.equal("3700");
    expect(record.rounds[1].buyer.correction).to.equal("no-backtracking");
  });

  it("expires with neither number on-chain when the positions never cross", async () => {
    const { sealed, agent, negotiate } = await setup();
    const record = await negotiate(agent("buyer", 3600, [3400, 3500, 3600]), agent("seller", 4100, [4500, 4300, 4100]));

    expect(record.outcome).to.equal("expired");
    expect(record.rounds).to.have.length(3);
    expect(record.rounds.every((r) => !r.crossed)).to.equal(true);

    const n = await sealed.getNegotiation(BigInt(record.negotiationId));
    expect(n.status).to.equal(4n); // Expired
    expect(n.settledPrice).to.equal(0n);
    for (const round of record.rounds) {
      for (const side of [round.buyer, round.seller]) {
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(side.offer)]).slice(2);
        const calldata = (await ethers.provider.getTransaction(side.commitTx))!.data.toLowerCase();
        expect(calldata.includes(encoded)).to.equal(false);
      }
    }
  });

  it("refuses a reveal that does not match what the agent committed on-chain", async () => {
    const { agent, negotiate } = await setup();
    const liar = agent("seller", 3900, [4600]);
    const honestReveal = liar.reveal.bind(liar);
    liar.reveal = (): Reveal => {
      const r = honestReveal();
      return { ...r, position: { ...r.position, offer: 3000n } };
    };

    const record = await negotiate(agent("buyer", 4500, [4000]), liar);
    expect(record.outcome).to.equal("aborted");
    expect(record.abortReason).to.match(/does not match its on-chain commitment/);
  });

  it("fails closed when the model gives no usable answer", async () => {
    const { agent, negotiate } = await setup();
    const record = await negotiate(agent("buyer", 4500, ["garbage"]), agent("seller", 3900, [4100]));

    expect(record.outcome).to.equal("aborted");
    expect(record.rounds).to.have.length(0);
    expect(record.expireTx).to.be.a("string");
  });

  it("explains each committed number from the numbers, not from the model", async () => {
    const { agent, negotiate } = await setup();
    const record = await negotiate(agent("buyer", 4000, [3800, 9999]), agent("seller", 3900, [4600, 3950]));

    expect(record.rounds[0].buyer.explanation).to.equal("Opened at 3800, 200 below the reference, 200 below its limit.");
    expect(record.rounds[1].buyer.explanation).to.equal(
      "Moved up 200 to 4000, equal to the reference, at its limit. The model asked for 9999; code held the buyer to its limit of 4000.",
    );
    expect(record.rounds[1].seller.stance).to.equal("concede");
  });

  it("treats an answer on the wrong scale as no answer", async () => {
    const { agent, negotiate } = await setup();
    const record = await negotiate(agent("buyer", 4500, [4200]), agent("seller", 3900, [3950000000000000]));

    expect(record.outcome).to.equal("aborted");
    expect(record.abortReason).to.match(/implausible offer/);
  });

  it("will not sign an authorization over a commitment that is not its own latest", async () => {
    const { agent, negotiate } = await setup();
    const buyer = agent("buyer", 4500, [3800]);
    const seller = agent("seller", 4400, [4600]);
    const record = await negotiate(buyer, seller);
    expect(record.outcome).to.equal("expired");

    const stale = {
      negotiationId: BigInt(record.negotiationId),
      buyerCommitment: ethers.ZeroHash,
      sellerCommitment: record.rounds[0].seller.commitment,
      buyerCommitIndex: 1,
      sellerCommitIndex: 1,
    };
    await expect(buyer.authorize(stale)).to.be.rejectedWith(/does not match its own latest commitment/);
  });
  it("works in steps: reads the negotiation and the counterparty's on-chain reputation before it commits", async () => {
    const { agent, negotiate } = await setup();
    const model = new ToolUsingModel([
      calls(["read_negotiation", {}], ["read_counterparty_reputation", {}]),
      calls(["check_offer", { offer: 4200 }]),
      submit({ offer: 4200, stance: "open-with-room", note: "Seller is well reviewed; open at 4200 and move up 100 a round." }),
    ]);
    const record = await negotiate(agent("buyer", 4500, model), agent("seller", 3900, [4100]));

    expect(record.outcome).to.equal("settled");
    const buyer = record.rounds[0].buyer;
    expect(buyer.steps!.map((s) => s.tool)).to.deep.equal(["read_negotiation", "read_counterparty_reputation", "check_offer", "submit_offer"]);
    expect(JSON.parse(buyer.steps![0].output)).to.include({ round: 1, roundsLeft: 2, status: "Open" });
    expect(JSON.parse(buyer.steps![1].output)).to.include({ reviews: 6, average: "4.40" });
    expect(JSON.parse(buyer.steps![2].output)).to.include({ allowed: true });
    expect(buyer.note).to.equal("Seller is well reviewed; open at 4200 and move up 100 a round.");
  });

  it("hands a rejected offer back to the model, which can correct itself", async () => {
    const { agent, negotiate } = await setup();
    const model = new ToolUsingModel([
      submit({ offer: 9999, stance: "open-with-room", note: "" }),
      submit({ offer: 4400, stance: "open-with-room", note: "" }),
    ]);
    const record = await negotiate(agent("buyer", 4500, model), agent("seller", 3900, [4600]));

    const buyer = record.rounds[0].buyer;
    expect(buyer.offer).to.equal("4400");
    expect(buyer.correction).to.equal(undefined);
    expect(buyer.steps![0].tool).to.equal("submit_offer");
    expect(buyer.steps![0].output).to.match(/rejected: above your limit of 4500/);
  });

  it("makes a model that only reads submit before its turns run out", async () => {
    const { agent, negotiate } = await setup();
    const forced: (string | undefined)[] = [];
    const reader: LlmClient = {
      model: "reader",
      async chat(_messages, tools, forceTool) {
        forced.push(forceTool);
        return tools.length > 1 ? calls(["read_negotiation", {}]) : submit({ offer: 4200, stance: "open-with-room", note: "" });
      },
    };
    const record = await negotiate(agent("buyer", 4500, reader), agent("seller", 3900, [4100]));

    expect(record.outcome).to.equal("settled");
    expect(record.rounds[0].buyer.steps!.map((s) => s.tool)).to.deep.equal([
      "read_negotiation", "read_negotiation", "read_negotiation", "read_negotiation", "submit_offer",
    ]);
    expect(forced).to.deep.equal([undefined, undefined, undefined, undefined, "submit_offer"]);
  });

  it("carries its own notes from earlier rounds into the next round", async () => {
    const { agent, negotiate } = await setup();
    const model = new ToolUsingModel([
      submit({ offer: 3800, stance: "open-with-room", note: "Plan: 3800, then 3900, then 4000." }),
      calls(["read_negotiation", {}]),
      submit({ offer: 3900, stance: "concede", note: "Following the plan." }),
    ]);
    const record = await negotiate(agent("buyer", 4500, model), agent("seller", 4400, [4600, 4500, 4400]));

    const state = JSON.parse(record.rounds[1].buyer.steps![0].output);
    expect(state.yourEarlierRounds).to.deep.equal([{ round: 1, offer: "3800", crossed: false, note: "Plan: 3800, then 3900, then 4000." }]);
    expect(record.rounds[1].buyer.offer).to.equal("3900");
  });
});
