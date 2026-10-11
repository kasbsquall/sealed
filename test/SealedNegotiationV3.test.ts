import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployRegistries, leaveFeedback, registerAgent, repeat } from "./helpers/erc8004";
import { admissionPolicyHash } from "../agents/sealed/policy";

/**
 * v3: the v2 negotiation plus payment at settlement, terms signed by both
 * parties, and commits submitted by signature. Runs against the real ERC-8004
 * registries, like the v2 suite.
 */

const TERMS = ethers.id("US cents per 1,000 calls, 1,000,000 calls, 30 days");
// 6-decimal dollars: 10,000 units per cent, times 1,000 lots of 1,000 calls.
const SCALE = 10_000n * 1_000n;
const FLOAT = 100_000n * 10n ** 6n;

async function deploy() {
  const signers = await ethers.getSigners();
  const [deployer, buyer, seller, outsider, relayer, treasury] = signers;
  const reviewers = signers.slice(6, 9);

  const registries = await deployRegistries();
  const BUYER_AGENT_ID = await registerAgent(registries, buyer);
  const SELLER_AGENT_ID = await registerAgent(registries, seller);
  await leaveFeedback(registries, BUYER_AGENT_ID, reviewers, repeat(470n, 6));
  await leaveFeedback(registries, SELLER_AGENT_ID, reviewers, repeat(430n, 6));
  const POLICY = {
    reviewers: await Promise.all(reviewers.map((r) => r.getAddress())),
    minFeedbackCount: 5n,
    minAverageValue: 400n,
    decimals: 2,
    tag1: "",
  };

  const gate = await (
    await ethers.getContractFactory("ReputationGate")
  ).deploy(await registries.identity.getAddress(), await registries.reputation.getAddress());
  const sealed = await (await ethers.getContractFactory("SealedNegotiationV3")).deploy(
    await gate.getAddress(),
    treasury.address,
  );
  const usd = await (await ethers.getContractFactory("SealedTestUSD")).deploy();

  // The buyer keeps a float in escrow, unrelated to any one limit.
  await usd.mint(buyer.address, FLOAT);
  await usd.connect(buyer).approve(await sealed.getAddress(), FLOAT);
  await sealed.connect(buyer).depositFor(await usd.getAddress(), buyer.address, FLOAT);

  const PARTIES = {
    buyerAgentId: BUYER_AGENT_ID,
    buyerWallet: buyer.address,
    sellerAgentId: SELLER_AGENT_ID,
    sellerWallet: seller.address,
  };
  const PAYMENT = { token: await usd.getAddress(), scale: SCALE };
  return { deployer, buyer, seller, outsider, relayer, treasury, registries, gate, sealed, usd, POLICY, PARTIES, PAYMENT };
}
type Ctx = Awaited<ReturnType<typeof deploy>>;

async function domain(sealed: any) {
  return {
    name: "Sealed",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await sealed.getAddress(),
  };
}

const OPEN_TYPES = {
  OpenNegotiation: [
    { name: "buyerAgentId", type: "uint256" },
    { name: "buyerWallet", type: "address" },
    { name: "sellerAgentId", type: "uint256" },
    { name: "sellerWallet", type: "address" },
    { name: "deadline", type: "uint64" },
    { name: "termsSchema", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "scale", type: "uint256" },
  ],
};

async function consent(ctx: Ctx, signer: any, deadline: bigint, overrides: Partial<{ scale: bigint; policyHash: string }> = {}) {
  return signer.signTypedData(await domain(ctx.sealed), OPEN_TYPES, {
    ...ctx.PARTIES,
    deadline,
    termsSchema: TERMS,
    policyHash: overrides.policyHash ?? admissionPolicyHash(ctx.POLICY),
    token: ctx.PAYMENT.token,
    scale: overrides.scale ?? ctx.PAYMENT.scale,
  });
}

/** Opens negotiation 1 from the relayer, with both parties' consent. */
async function open(ctx: Ctx, hours = 1) {
  const deadline = BigInt(await time.latest()) + BigInt(hours * 3600);
  await ctx.sealed
    .connect(ctx.relayer)
    .createNegotiation(ctx.PARTIES, deadline, TERMS, ctx.POLICY, ctx.PAYMENT, await consent(ctx, ctx.buyer, deadline), await consent(ctx, ctx.seller, deadline));
  return { id: 1n, deadline };
}

async function commitmentFor(sealed: any, id: bigint, party: string, index: number, offer: bigint) {
  const salt = ethers.hexlify(ethers.randomBytes(32));
  return { salt, offer, hash: await sealed.commitmentHash(id, party, index, offer, salt) };
}

async function authorize(sealed: any, signer: any, id: bigint) {
  const n = await sealed.getNegotiation(id);
  const round = n.buyerCommitIndex < n.sellerCommitIndex ? n.buyerCommitIndex : n.sellerCommitIndex;
  return signer.signTypedData(
    await domain(sealed),
    {
      SettleAuthorization: [
        { name: "negotiationId", type: "uint256" },
        { name: "buyerCommitment", type: "bytes32" },
        { name: "sellerCommitment", type: "bytes32" },
        { name: "buyerCommitIndex", type: "uint32" },
        { name: "sellerCommitIndex", type: "uint32" },
      ],
    },
    {
      negotiationId: id,
      buyerCommitment: n.buyerCommitIndex === round ? n.buyerCommitment : ethers.ZeroHash,
      sellerCommitment: n.sellerCommitIndex === round ? n.sellerCommitment : ethers.ZeroHash,
      buyerCommitIndex: round,
      sellerCommitIndex: round,
    },
  );
}

async function signCommit(sealed: any, signer: any, id: bigint, commitment: string, commitIndex: number) {
  return signer.signTypedData(
    await domain(sealed),
    {
      Commit: [
        { name: "negotiationId", type: "uint256" },
        { name: "commitment", type: "bytes32" },
        { name: "commitIndex", type: "uint32" },
      ],
    },
    { negotiationId: id, commitment, commitIndex },
  );
}

/** One round committed by both parties directly; returns what settle needs. */
async function round1(ctx: Ctx, id: bigint, buyerOffer: bigint, sellerOffer: bigint) {
  const b = await commitmentFor(ctx.sealed, id, ctx.buyer.address, 1, buyerOffer);
  const s = await commitmentFor(ctx.sealed, id, ctx.seller.address, 1, sellerOffer);
  await ctx.sealed.connect(ctx.buyer).commitOffer(id, b.hash);
  await ctx.sealed.connect(ctx.seller).commitOffer(id, s.hash);
  return { b, s, auth: { buyer: await authorize(ctx.sealed, ctx.buyer, id), seller: await authorize(ctx.sealed, ctx.seller, id) } };
}

describe("SealedNegotiationV3: opening on signed terms", () => {
  it("opens when both parties signed the exact terms, and locks the buyer's escrow", async () => {
    const ctx = await deploy();
    const { id } = await open(ctx);
    const n = await ctx.sealed.getNegotiation(id);
    expect(n.status).to.equal(1n);
    expect(n.policyHash).to.equal(admissionPolicyHash(ctx.POLICY));
    const p = await ctx.sealed.getPayment(id);
    expect(p.token).to.equal(ctx.PAYMENT.token);
    expect(p.scale).to.equal(SCALE);
    expect(await ctx.sealed.openAsBuyer(ctx.buyer.address)).to.equal(1n);
  });

  it("refuses to open without the seller's signature", async () => {
    const ctx = await deploy();
    const deadline = BigInt(await time.latest()) + 3600n;
    await expect(
      ctx.sealed.connect(ctx.relayer).createNegotiation(ctx.PARTIES, deadline, TERMS, ctx.POLICY, ctx.PAYMENT, await consent(ctx, ctx.buyer, deadline), "0x"),
    ).to.be.revertedWithCustomError(ctx.sealed, "BadConsent").withArgs(ctx.seller.address);
  });

  it("refuses a signature over different terms: another scale or another policy", async () => {
    const ctx = await deploy();
    const deadline = BigInt(await time.latest()) + 3600n;
    const sellerOk = await consent(ctx, ctx.seller, deadline);
    await expect(
      ctx.sealed.connect(ctx.relayer).createNegotiation(ctx.PARTIES, deadline, TERMS, ctx.POLICY, ctx.PAYMENT, await consent(ctx, ctx.buyer, deadline, { scale: SCALE / 2n }), sellerOk),
    ).to.be.revertedWithCustomError(ctx.sealed, "BadConsent").withArgs(ctx.buyer.address);
    await expect(
      ctx.sealed.connect(ctx.relayer).createNegotiation(ctx.PARTIES, deadline, TERMS, ctx.POLICY, ctx.PAYMENT, await consent(ctx, ctx.buyer, deadline, { policyHash: ethers.ZeroHash }), sellerOk),
    ).to.be.revertedWithCustomError(ctx.sealed, "BadConsent").withArgs(ctx.buyer.address);
  });

  it("a party that is the caller needs no signature of its own", async () => {
    const ctx = await deploy();
    const deadline = BigInt(await time.latest()) + 3600n;
    await ctx.sealed.connect(ctx.buyer).createNegotiation(ctx.PARTIES, deadline, TERMS, ctx.POLICY, ctx.PAYMENT, "0x", await consent(ctx, ctx.seller, deadline));
    expect((await ctx.sealed.getNegotiation(1n)).status).to.equal(1n);
  });

  it("still refuses an agent that does not clear the policy", async () => {
    const ctx = await deploy();
    const strict = { ...ctx.POLICY, minFeedbackCount: 50n };
    const deadline = BigInt(await time.latest()) + 3600n;
    const sign = async (s: any) => s.signTypedData(await domain(ctx.sealed), OPEN_TYPES, { ...ctx.PARTIES, deadline, termsSchema: TERMS, policyHash: admissionPolicyHash(strict), ...ctx.PAYMENT });
    await expect(
      ctx.sealed.connect(ctx.relayer).createNegotiation(ctx.PARTIES, deadline, TERMS, strict, ctx.PAYMENT, await sign(ctx.buyer), await sign(ctx.seller)),
    ).to.be.revertedWithCustomError(ctx.gate, "NotAdmitted");
  });

  it("a pair of consents opens one negotiation: replaying the same call is refused", async () => {
    const ctx = await deploy();
    const deadline = BigInt(await time.latest()) + 3600n;
    const args = [ctx.PARTIES, deadline, TERMS, ctx.POLICY, ctx.PAYMENT, await consent(ctx, ctx.buyer, deadline), await consent(ctx, ctx.seller, deadline)] as const;
    await ctx.sealed.connect(ctx.relayer).createNegotiation(...args);
    await expect(ctx.sealed.connect(ctx.outsider).createNegotiation(...args)).to.be.revertedWithCustomError(ctx.sealed, "ConsentUsed");
    expect(await ctx.sealed.openAsBuyer(ctx.buyer.address)).to.equal(1n);
  });

  it("refuses a deadline more than seven days away, so a float is never locked longer", async () => {
    const ctx = await deploy();
    const deadline = BigInt(await time.latest()) + 7n * 86400n + 60n;
    await expect(
      ctx.sealed.connect(ctx.relayer).createNegotiation(ctx.PARTIES, deadline, TERMS, ctx.POLICY, ctx.PAYMENT, await consent(ctx, ctx.buyer, deadline), await consent(ctx, ctx.seller, deadline)),
    ).to.be.revertedWithCustomError(ctx.sealed, "DeadlineTooFar");
  });

  it("refuses to deploy without a treasury", async () => {
    const ctx = await deploy();
    const factory = await ethers.getContractFactory("SealedNegotiationV3");
    await expect(factory.deploy(await ctx.gate.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroTreasury");
  });

  it("refuses payment terms without a token or a scale", async () => {
    const ctx = await deploy();
    const deadline = BigInt(await time.latest()) + 3600n;
    await expect(
      ctx.sealed.connect(ctx.buyer).createNegotiation(ctx.PARTIES, deadline, TERMS, ctx.POLICY, { token: ctx.PAYMENT.token, scale: 0n }, "0x", "0x"),
    ).to.be.revertedWithCustomError(ctx.sealed, "BadPaymentTerms");
  });
});

describe("SealedNegotiationV3: payment at settlement", () => {
  it("pays the midpoint price from the buyer's escrow: seller gets it less 0.25%, the treasury the fee", async () => {
    const ctx = await deploy();
    const { id } = await open(ctx);
    const { b, s, auth } = await round1(ctx, id, 4250n, 4130n);
    const price = 4130n + (4250n - 4130n) / 2n; // 4190, $41.90 per 1,000 calls
    const amount = price * SCALE; // $41,900 for 1,000,000 calls
    const fee = (amount * 25n) / 10_000n; // $104.75

    await expect(ctx.sealed.connect(ctx.relayer).settle(id, b, s, auth.buyer, auth.seller))
      .to.emit(ctx.sealed, "Paid")
      .withArgs(id, ctx.PAYMENT.token, ctx.buyer.address, ctx.seller.address, amount, fee);

    expect(fee).to.equal(104_750_000n);
    expect(await ctx.usd.balanceOf(ctx.seller.address)).to.equal(amount - fee);
    expect(await ctx.usd.balanceOf(ctx.treasury.address)).to.equal(fee);
    expect(await ctx.sealed.escrowOf(ctx.PAYMENT.token, ctx.buyer.address)).to.equal(FLOAT - amount);
    expect(await ctx.sealed.openAsBuyer(ctx.buyer.address)).to.equal(0n);
    expect((await ctx.sealed.getNegotiation(id)).settledPrice).to.equal(price);
  });

  it("reverts the whole settlement when the escrow cannot cover the price, and pays nothing", async () => {
    const ctx = await deploy();
    await ctx.sealed.connect(ctx.buyer).withdraw(ctx.PAYMENT.token, FLOAT - 1_000n * 10n ** 6n); // keep $1,000
    const { id } = await open(ctx);
    const { b, s, auth } = await round1(ctx, id, 4250n, 4130n);
    await expect(ctx.sealed.settle(id, b, s, auth.buyer, auth.seller)).to.be.revertedWithCustomError(ctx.sealed, "InsufficientEscrow");
    expect((await ctx.sealed.getNegotiation(id)).status).to.equal(2n);
    expect(await ctx.usd.balanceOf(ctx.seller.address)).to.equal(0n);
  });

  it("keeps v2's checks: incompatible offers and a wrong reveal still revert", async () => {
    const ctx = await deploy();
    const { id } = await open(ctx);
    const { b, s, auth } = await round1(ctx, id, 4000n, 4130n);
    await expect(ctx.sealed.settle(id, b, s, auth.buyer, auth.seller)).to.be.revertedWithCustomError(ctx.sealed, "IncompatibleOffers");
    await expect(ctx.sealed.settle(id, { ...b, offer: 4300n }, s, auth.buyer, auth.seller)).to.be.revertedWithCustomError(ctx.sealed, "CommitmentMismatch");
  });

  it("an expired negotiation pays nothing and releases the escrow lock", async () => {
    const ctx = await deploy();
    const { id, deadline } = await open(ctx);
    await round1(ctx, id, 4000n, 4130n);
    await time.increaseTo(deadline);
    await expect(ctx.sealed.expire(id)).to.emit(ctx.sealed, "NegotiationExpired");
    expect(await ctx.sealed.openAsBuyer(ctx.buyer.address)).to.equal(0n);
    expect(await ctx.sealed.escrowOf(ctx.PAYMENT.token, ctx.buyer.address)).to.equal(FLOAT);
  });
});

describe("SealedNegotiationV3: escrow", () => {
  it("a buyer cannot withdraw while a paid negotiation is open, and can once it closes", async () => {
    const ctx = await deploy();
    const { id } = await open(ctx);
    await expect(ctx.sealed.connect(ctx.buyer).withdraw(ctx.PAYMENT.token, 1n)).to.be.revertedWithCustomError(ctx.sealed, "EscrowLocked").withArgs(1n);
    const { b, s, auth } = await round1(ctx, id, 4250n, 4130n);
    await ctx.sealed.settle(id, b, s, auth.buyer, auth.seller);
    const left = await ctx.sealed.escrowOf(ctx.PAYMENT.token, ctx.buyer.address);
    await ctx.sealed.connect(ctx.buyer).withdraw(ctx.PAYMENT.token, left);
    expect(await ctx.usd.balanceOf(ctx.buyer.address)).to.equal(left);
  });

  it("anyone can fund another account's float, and only that account can withdraw it", async () => {
    const ctx = await deploy();
    await ctx.usd.mint(ctx.outsider.address, 500n);
    await ctx.usd.connect(ctx.outsider).approve(await ctx.sealed.getAddress(), 500n);
    await expect(ctx.sealed.connect(ctx.outsider).depositFor(ctx.PAYMENT.token, ctx.seller.address, 500n))
      .to.emit(ctx.sealed, "Deposited")
      .withArgs(ctx.PAYMENT.token, ctx.seller.address, ctx.outsider.address, 500n);
    await expect(ctx.sealed.connect(ctx.outsider).withdraw(ctx.PAYMENT.token, 500n)).to.be.revertedWithCustomError(ctx.sealed, "InsufficientEscrow");
    await ctx.sealed.connect(ctx.seller).withdraw(ctx.PAYMENT.token, 500n);
    expect(await ctx.usd.balanceOf(ctx.seller.address)).to.equal(500n);
  });

  it("the test dollar caps each mint", async () => {
    const ctx = await deploy();
    await expect(ctx.usd.mint(ctx.outsider.address, 1_000_001n * 10n ** 6n)).to.be.revertedWithCustomError(ctx.usd, "OverMintCap");
  });
});

describe("SealedNegotiationV3: commits by signature", () => {
  it("a relayer submits both parties' signed commits, and the deal settles and pays", async () => {
    const ctx = await deploy();
    const { id } = await open(ctx);
    const b = await commitmentFor(ctx.sealed, id, ctx.buyer.address, 1, 4250n);
    const s = await commitmentFor(ctx.sealed, id, ctx.seller.address, 1, 4130n);
    await expect(ctx.sealed.connect(ctx.relayer).commitOfferBySig(id, ctx.buyer.address, b.hash, await signCommit(ctx.sealed, ctx.buyer, id, b.hash, 1)))
      .to.emit(ctx.sealed, "OfferCommitted")
      .withArgs(id, ctx.buyer.address, 1);
    await ctx.sealed.connect(ctx.relayer).commitOfferBySig(id, ctx.seller.address, s.hash, await signCommit(ctx.sealed, ctx.seller, id, s.hash, 1));
    await ctx.sealed.connect(ctx.relayer).settle(id, b, s, await authorize(ctx.sealed, ctx.buyer, id), await authorize(ctx.sealed, ctx.seller, id));
    expect((await ctx.sealed.getNegotiation(id)).status).to.equal(3n);
  });

  it("refuses a commit signed by someone else", async () => {
    const ctx = await deploy();
    const { id } = await open(ctx);
    const b = await commitmentFor(ctx.sealed, id, ctx.buyer.address, 1, 4250n);
    await expect(
      ctx.sealed.commitOfferBySig(id, ctx.buyer.address, b.hash, await signCommit(ctx.sealed, ctx.outsider, id, b.hash, 1)),
    ).to.be.revertedWithCustomError(ctx.sealed, "BadCommitSignature").withArgs(ctx.buyer.address);
  });

  it("a signed commit cannot be replayed into a later round", async () => {
    const ctx = await deploy();
    const { id } = await open(ctx);
    const b = await commitmentFor(ctx.sealed, id, ctx.buyer.address, 1, 4250n);
    const sig = await signCommit(ctx.sealed, ctx.buyer, id, b.hash, 1);
    await ctx.sealed.commitOfferBySig(id, ctx.buyer.address, b.hash, sig);
    const s = await commitmentFor(ctx.sealed, id, ctx.seller.address, 1, 4130n);
    await ctx.sealed.connect(ctx.seller).commitOffer(id, s.hash);
    await expect(ctx.sealed.commitOfferBySig(id, ctx.buyer.address, b.hash, sig)).to.be.revertedWithCustomError(ctx.sealed, "BadCommitSignature");
  });

  it("keeps the v2 freeze: a side cannot commit two rounds ahead", async () => {
    const ctx = await deploy();
    const { id } = await open(ctx);
    const b1 = await commitmentFor(ctx.sealed, id, ctx.buyer.address, 1, 4000n);
    const b2 = await commitmentFor(ctx.sealed, id, ctx.buyer.address, 2, 4100n);
    await ctx.sealed.connect(ctx.buyer).commitOffer(id, b1.hash);
    await expect(ctx.sealed.commitOfferBySig(id, ctx.buyer.address, b2.hash, await signCommit(ctx.sealed, ctx.buyer, id, b2.hash, 2)))
      .to.be.revertedWithCustomError(ctx.sealed, "AlreadyCommitted");
  });
});
