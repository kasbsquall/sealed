import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Interface } from "ethers";
import {
  REPUTATION_GATE_ABI,
  SEALED_NEGOTIATION_ABI,
  SEALED_NEGOTIATION_V3_EXTRA_ABI,
  SealedReader,
  admissionPolicyHash,
  commitmentHash,
  newSalt,
  settleAuthorizationDigest,
  settleAuthorizationTypedData,
  type SealedDeployment,
} from "../packages/sealed/src";
import { deployRegistries, leaveFeedback, registerAgent, repeat } from "./helpers/erc8004";
import { commitTypedData, openNegotiationTypedData } from "../agents/sealed/commitment";

/**
 * The sealed-monad package against a real v2 deployment on the local network:
 * its encoders must give the contract's own commitment, digest and policy
 * hash, its ABIs must match the compiled contracts, and its read client must
 * verify a real settlement end to end, including one where a side committed
 * ahead of the settled round.
 */
describe("sealed-monad SDK", () => {
  async function deploy() {
    const signers = await ethers.getSigners();
    const [, buyer, seller] = signers;
    const reviewers = signers.slice(4, 7);
    const registries = await deployRegistries();
    const buyerAgentId = await registerAgent(registries, buyer);
    const sellerAgentId = await registerAgent(registries, seller);
    await leaveFeedback(registries, buyerAgentId, reviewers, repeat(470n, 6));
    await leaveFeedback(registries, sellerAgentId, reviewers, repeat(430n, 2));
    const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(
      await registries.identity.getAddress(),
      await registries.reputation.getAddress(),
    );
    const sealed = await (await ethers.getContractFactory("SealedNegotiation")).deploy(await gate.getAddress());
    const deployment: SealedDeployment = {
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      name: "hardhat",
      version: 2,
      rpcUrl: "http://127.0.0.1:8545",
      explorer: "",
      sealedNegotiation: await sealed.getAddress(),
      reputationGate: await gate.getAddress(),
      identityRegistry: await registries.identity.getAddress(),
      reputationRegistry: await registries.reputation.getAddress(),
      demoPolicy: { reviewers: await Promise.all(reviewers.map((r) => r.getAddress())), minFeedbackCount: 2n, minAverageValue: 400n, decimals: 2, tag1: "" },
    };
    const reader = new SealedReader({ provider: ethers.provider, deployment });
    return { buyer, seller, sealed, deployment, reader, buyerAgentId, sellerAgentId };
  }

  type Ctx = Awaited<ReturnType<typeof deploy>>;
  type Offer = { offer: bigint; salt: string };

  /**
   * v2 rules: one commit per side per round, at most one round ahead. Two
   * complete rounds (the second crosses), both sign round 2, then, with
   * `buyerRacesAhead`, the buyer commits round 3 before the settlement lands,
   * which v2 lets through: settle still takes round 2.
   */
  async function settledNegotiation(ctx: Ctx, { buyerRacesAhead = false } = {}) {
    const { sealed, deployment, buyer, seller } = ctx;
    const domain = { chainId: deployment.chainId, verifyingContract: deployment.sealedNegotiation };
    const policy = { ...deployment.demoPolicy, reviewers: [...deployment.demoPolicy.reviewers] };
    await sealed.createNegotiation(ctx.buyerAgentId, buyer.address, ctx.sellerAgentId, seller.address, BigInt(await time.latest()) + 3600n, ethers.id("terms"), policy);
    const commit = async (signer: typeof buyer, commitIndex: number, position: Offer) =>
      (await sealed.connect(signer).commitOffer(1n, commitmentHash({ domain, negotiationId: 1n, party: signer.address, commitIndex, position }))).hash;
    const offer = (value: bigint): Offer => ({ offer: value, salt: newSalt() });

    await commit(buyer, 1, offer(3900n));
    await commit(seller, 1, offer(4400n));
    const settled = { buyer: offer(4250n), seller: offer(4130n) };
    const commitTxs = { buyer: await commit(buyer, 2, settled.buyer), seller: await commit(seller, 2, settled.seller) };

    const n = await sealed.getNegotiation(1n);
    const message = { negotiationId: 1n, buyerCommitment: n.buyerCommitment, sellerCommitment: n.sellerCommitment, buyerCommitIndex: 2, sellerCommitIndex: 2 };
    const typed = settleAuthorizationTypedData(domain, message);
    const types = { SettleAuthorization: [...typed.types.SettleAuthorization] };
    const [buyerSig, sellerSig] = await Promise.all([buyer.signTypedData(typed.domain, types, message), seller.signTypedData(typed.domain, types, message)]);
    if (buyerRacesAhead) await commit(buyer, 3, offer(4000n));
    const settleTx = await sealed.settle(1n, settled.buyer, settled.seller, buyerSig, sellerSig);
    return { domain, message, policy, settleTx: settleTx.hash, commitTxs };
  }

  it("encodes commitments, the settlement digest and the policy hash exactly as the contract does", async () => {
    const ctx = await deploy();
    const { domain, message, policy } = await settledNegotiation(ctx);
    expect(settleAuthorizationDigest(domain, message)).to.equal(await ctx.sealed.settleAuthorizationDigest(1n));
    for (const c of [{ id: 1n, index: 1, offer: 0n }, { id: 9n, index: 77, offer: 2n ** 256n - 1n }]) {
      const salt = newSalt();
      expect(commitmentHash({ domain, negotiationId: c.id, party: ctx.buyer.address, commitIndex: c.index, position: { offer: c.offer, salt } })).to.equal(
        await ctx.sealed.commitmentHash(c.id, ctx.buyer.address, c.index, c.offer, salt),
      );
    }
    expect(admissionPolicyHash(ctx.deployment.demoPolicy)).to.equal(await ctx.sealed.admissionPolicyHash(policy));
  });

  it("ships ABIs that match the compiled contracts", async () => {
    for (const [name, abi] of [["SealedNegotiation", SEALED_NEGOTIATION_ABI], ["ReputationGate", REPUTATION_GATE_ABI]] as const) {
      const compiled = new Interface((await artifacts.readArtifact(name)).abi).format(true);
      expect([...new Interface(abi).format(true)].sort(), name).to.deep.equal([...compiled].sort());
    }
    const v3 = new Set(new Interface((await artifacts.readArtifact("SealedNegotiationV3")).abi).format(true));
    for (const fragment of new Interface(SEALED_NEGOTIATION_V3_EXTRA_ABI).format(true)) expect(v3.has(fragment), fragment).to.equal(true);
  });

  it("reads negotiations with their policy hash, commit indices, admission and reputation", async () => {
    const ctx = await deploy();
    await settledNegotiation(ctx, { buyerRacesAhead: true });
    const n = await ctx.reader.getNegotiation(1);
    expect(n).to.include({ status: "Settled", settledPrice: 4190n, layout: 2, settleableRound: 2 });
    expect(n.policyHash).to.equal(admissionPolicyHash(ctx.deployment.demoPolicy));
    expect(n.extra).to.deep.equal([]);
    expect(await ctx.reader.getCommitIndices(1)).to.deep.equal({ buyer: 3, seller: 2 });
    expect((await ctx.reader.getNegotiation(99)).status).to.equal("None");

    const admitted = await ctx.reader.checkAdmission(ctx.buyerAgentId);
    expect(admitted).to.include({ admitted: true, isAgentWallet: true, clears: true, registeredWallet: ctx.buyer.address, policyHash: n.policyHash });
    const impostor = await ctx.reader.checkAdmission(ctx.buyerAgentId, { wallet: ctx.seller.address });
    expect(impostor).to.include({ admitted: false, isAgentWallet: false });
    const strict = await ctx.reader.checkAdmission(ctx.sellerAgentId, { policy: { ...ctx.deployment.demoPolicy, minFeedbackCount: 5n } });
    expect(strict).to.include({ admitted: false, clears: false });

    const reputation = await ctx.reader.readReputation(ctx.buyerAgentId);
    expect(reputation).to.include({ count: 6n, average: 470n, decimals: 2, averageText: "4.70" });
  });

  for (const buyerRacesAhead of [false, true]) {
    it(`verifies a real settlement and finds its commit transactions${buyerRacesAhead ? ", with the buyer one round ahead" : ""}`, async () => {
      const ctx = await deploy();
      const { settleTx, commitTxs } = await settledNegotiation(ctx, { buyerRacesAhead });
      const report = await ctx.reader.verifySettlement(settleTx);
      expect(report.checks.filter((c) => !c.ok)).to.deep.equal([]);
      expect(report).to.include({ ok: true, price: 4190n, contractVersion: 2 });
      expect(report.buyer).to.include({ commitIndex: 2, latestCommitIndex: buyerRacesAhead ? 3 : 2, commitTx: commitTxs.buyer });
      expect(report.seller).to.include({ commitIndex: 2, latestCommitIndex: 2, commitTx: commitTxs.seller });
    });
  }

  it("does not verify a transaction that is not a settlement", async () => {
    const ctx = await deploy();
    const { commitTxs } = await settledNegotiation(ctx);
    const report = await ctx.reader.verifySettlement(commitTxs.seller);
    expect(report.ok).to.equal(false);
    expect(report.checks.find((c) => c.label === "is a settle call")?.ok).to.equal(false);
    expect((await ctx.reader.verifySettlement(ethers.ZeroHash)).ok).to.equal(false);
  });
});

/**
 * v3 through the same read client: a paid negotiation where some commitments
 * are sent by the party and some by a relayer with the party's signature, as
 * at the public desk. verifySettlement must recognize v3, accept both kinds of
 * commit, and check that the price left the buyer's escrow with the fee.
 */
describe("sealed-monad SDK on v3 (payment at settlement)", () => {
  const SCALE = 10_000n * 1_000n;
  const FLOAT = 100_000n * 10n ** 6n;

  async function paidSettlement() {
    const signers = await ethers.getSigners();
    const [, buyer, seller, relayer, treasury] = signers;
    const reviewers = signers.slice(5, 8);
    const registries = await deployRegistries();
    const buyerAgentId = await registerAgent(registries, buyer);
    const sellerAgentId = await registerAgent(registries, seller);
    await leaveFeedback(registries, buyerAgentId, reviewers, repeat(470n, 2));
    await leaveFeedback(registries, sellerAgentId, reviewers, repeat(430n, 2));
    const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(
      await registries.identity.getAddress(),
      await registries.reputation.getAddress(),
    );
    const sealed = await (await ethers.getContractFactory("SealedNegotiationV3")).deploy(await gate.getAddress(), treasury.address);
    const usd = await (await ethers.getContractFactory("SealedTestUSD")).deploy();
    await usd.mint(buyer.address, FLOAT);
    await usd.connect(buyer).approve(await sealed.getAddress(), FLOAT);
    await sealed.connect(buyer).depositFor(await usd.getAddress(), buyer.address, FLOAT);

    const deployment: SealedDeployment = {
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      name: "hardhat v3",
      version: 3,
      rpcUrl: "http://127.0.0.1:8545",
      explorer: "",
      sealedNegotiation: await sealed.getAddress(),
      reputationGate: await gate.getAddress(),
      identityRegistry: await registries.identity.getAddress(),
      reputationRegistry: await registries.reputation.getAddress(),
      demoPolicy: { reviewers: await Promise.all(reviewers.map((r) => r.getAddress())), minFeedbackCount: 2n, minAverageValue: 400n, decimals: 2, tag1: "" },
    };
    const domain = { chainId: BigInt(deployment.chainId), verifyingContract: deployment.sealedNegotiation };
    const policy = { ...deployment.demoPolicy, reviewers: [...deployment.demoPolicy.reviewers] };
    const parties = { buyerAgentId, buyerWallet: buyer.address, sellerAgentId, sellerWallet: seller.address };
    const payment = { token: await usd.getAddress(), scale: SCALE };
    const open = { ...parties, deadline: BigInt(await time.latest()) + 3600n, termsSchema: ethers.id("terms"), policyHash: admissionPolicyHash(deployment.demoPolicy), ...payment };
    const openTyped = openNegotiationTypedData(domain, open);
    const sellerConsent = await seller.signTypedData(openTyped.domain, { OpenNegotiation: [...openTyped.types.OpenNegotiation] }, open);
    await sealed.connect(buyer).createNegotiation(parties, open.deadline, open.termsSchema, policy, payment, "0x", sellerConsent);

    type Offer = { offer: bigint; salt: string };
    const offer = (value: bigint): Offer => ({ offer: value, salt: newSalt() });
    const hashOf = (party: string, commitIndex: number, position: Offer) => commitmentHash({ domain, negotiationId: 1n, party, commitIndex, position });
    const direct = async (signer: typeof buyer, commitIndex: number, position: Offer) =>
      (await sealed.connect(signer).commitOffer(1n, hashOf(signer.address, commitIndex, position))).hash;
    const bySig = async (signer: typeof buyer, commitIndex: number, position: Offer) => {
      const commitment = hashOf(signer.address, commitIndex, position);
      const typed = commitTypedData(domain, { negotiationId: 1n, commitment, commitIndex });
      const signature = await signer.signTypedData(typed.domain, { Commit: [...typed.types.Commit] }, typed.message);
      return (await sealed.connect(relayer).commitOfferBySig(1n, signer.address, commitment, signature)).hash;
    };

    await direct(buyer, 1, offer(3900n));
    await bySig(seller, 1, offer(4400n));
    const settled = { buyer: offer(4250n), seller: offer(4130n) };
    const commitTxs = { buyer: await bySig(buyer, 2, settled.buyer), seller: await direct(seller, 2, settled.seller) };

    const n = await sealed.getNegotiation(1n);
    const message = { negotiationId: 1n, buyerCommitment: n.buyerCommitment, sellerCommitment: n.sellerCommitment, buyerCommitIndex: 2, sellerCommitIndex: 2 };
    const typed = settleAuthorizationTypedData(domain, message);
    const types = { SettleAuthorization: [...typed.types.SettleAuthorization] };
    const [buyerSig, sellerSig] = await Promise.all([buyer.signTypedData(typed.domain, types, message), seller.signTypedData(typed.domain, types, message)]);
    const settleTx = (await sealed.connect(relayer).settle(1n, settled.buyer, settled.seller, buyerSig, sellerSig)).hash;
    const reader = new SealedReader({ provider: ethers.provider, deployment });
    return { reader, settleTx, commitTxs, treasury, usd, seller, relayer };
  }

  it("verifies a paid settlement, with commits sent by the party and by a relayer, and the price paid with the fee", async () => {
    const { reader, settleTx, commitTxs, treasury, usd } = await paidSettlement();
    const report = await reader.verifySettlement(settleTx);
    expect(report.checks.filter((c) => !c.ok)).to.deep.equal([]);
    expect(report).to.include({ ok: true, price: 4190n, contractVersion: 3 });
    expect(report.buyer).to.include({ commitIndex: 2, commitTx: commitTxs.buyer });
    expect(report.seller).to.include({ commitIndex: 2, commitTx: commitTxs.seller });
    const amount = 4190n * SCALE;
    const fee = (amount * 25n + 9_999n) / 10_000n;
    expect(report.payment).to.deep.include({ token: await usd.getAddress(), scale: SCALE, amount, fee, treasury: treasury.address });
    expect(report.checks.some((c) => c.label.includes("Paid"))).to.equal(true);
  });
});

