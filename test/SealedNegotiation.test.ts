import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HDNodeWallet } from "ethers";
import { deployRegistries, leaveFeedback, registerAgent, repeat } from "./helpers/erc8004";
import { admissionPolicyHash } from "../agents/sealed/policy";

/**
 * Every test runs against the real ERC-8004 registries (see
 * contracts/vendor/erc8004), so reputation is built the way it is on Base:
 * reviewers leave feedback entries, and the gate asks the registry for a
 * summary over the reviewers the policy trusts.
 */

type Feedback = { buyer?: bigint[]; seller?: bigint[] };

// Default history: buyer 12 entries averaging 4.70, seller 8 entries averaging 4.30.
const DEFAULT_FEEDBACK = { buyer: repeat(470n, 12), seller: repeat(430n, 8) };

async function deploy(feedback: Feedback = {}) {
  const signers = await ethers.getSigners();
  const [deployer, buyer, seller, outsider] = signers;
  const reviewers = signers.slice(4, 7);
  const untrustedReviewer = signers[7];

  const registries = await deployRegistries();
  const { identity, reputation } = registries;

  const BUYER_AGENT_ID = await registerAgent(registries, buyer);
  const SELLER_AGENT_ID = await registerAgent(registries, seller);
  await leaveFeedback(registries, BUYER_AGENT_ID, reviewers, feedback.buyer ?? DEFAULT_FEEDBACK.buyer);
  await leaveFeedback(registries, SELLER_AGENT_ID, reviewers, feedback.seller ?? DEFAULT_FEEDBACK.seller);

  // Policy: at least 5 entries from the trusted reviewers, averaging at least 4.00.
  const POLICY = {
    reviewers: await Promise.all(reviewers.map((r) => r.getAddress())),
    minFeedbackCount: 5n,
    minAverageValue: 400n,
    decimals: 2,
    tag1: "",
  };

  const gate = await (
    await ethers.getContractFactory("ReputationGate")
  ).deploy(await identity.getAddress(), await reputation.getAddress());

  const sealed = await (
    await ethers.getContractFactory("SealedNegotiation")
  ).deploy(await gate.getAddress());

  return {
    deployer, buyer, seller, outsider, reviewers, untrustedReviewer,
    registries, identity, reputation, gate, sealed,
    BUYER_AGENT_ID, SELLER_AGENT_ID, POLICY,
  };
}

async function openNegotiation(ctx: Awaited<ReturnType<typeof deploy>>, hours = 24) {
  const deadline = BigInt(await time.latest()) + BigInt(hours * 3600);
  await ctx.sealed.createNegotiation(
    ctx.BUYER_AGENT_ID,
    ctx.buyer.address,
    ctx.SELLER_AGENT_ID,
    ctx.seller.address,
    deadline,
    ethers.id("USD per unit, 1000 units, net 30"),
    ctx.POLICY,
  );
  return { id: 1n, deadline };
}

/** Signs the EIP-712 SettleAuthorization for the negotiation's current state. */
async function authorize(sealed: any, signer: any, negotiationId: bigint) {
  const n = await sealed.getNegotiation(negotiationId);
  const domain = {
    name: "Sealed",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await sealed.getAddress(),
  };
  const types = {
    SettleAuthorization: [
      { name: "negotiationId", type: "uint256" },
      { name: "buyerCommitment", type: "bytes32" },
      { name: "sellerCommitment", type: "bytes32" },
      { name: "buyerCommitIndex", type: "uint32" },
      { name: "sellerCommitIndex", type: "uint32" },
    ],
  };
  return signer.signTypedData(domain, types, {
    negotiationId,
    buyerCommitment: n.buyerCommitment,
    sellerCommitment: n.sellerCommitment,
    buyerCommitIndex: n.buyerCommitIndex,
    sellerCommitIndex: n.sellerCommitIndex,
  });
}

describe("ReputationGate", () => {
  it("admits an agent that clears both the count and the average", async () => {
    const ctx = await deploy();
    expect(await ctx.gate.clears(ctx.BUYER_AGENT_ID, ctx.POLICY)).to.equal(true);
  });

  it("rejects an agent with a good average but too little history", async () => {
    const ctx = await deploy({ seller: repeat(500n, 2) });
    expect(await ctx.gate.clears(ctx.SELLER_AGENT_ID, ctx.POLICY)).to.equal(false);
  });

  it("rejects an agent whose average is below the bar", async () => {
    const ctx = await deploy({ seller: repeat(310n, 40) });
    expect(await ctx.gate.clears(ctx.SELLER_AGENT_ID, ctx.POLICY)).to.equal(false);
  });

  it("ignores feedback from reviewers the policy does not trust", async () => {
    // The seller has too little trusted history. Fifty perfect scores from an
    // address the policy never named must not change that.
    const ctx = await deploy({ seller: repeat(500n, 2) });
    await leaveFeedback(ctx.registries, ctx.SELLER_AGENT_ID, [ctx.untrustedReviewer], repeat(500n, 50));
    expect(await ctx.gate.clears(ctx.SELLER_AGENT_ID, ctx.POLICY)).to.equal(false);
  });

  it("excludes feedback a reviewer has revoked", async () => {
    // Exactly 5 trusted entries; revoking one drops the seller below the count.
    const ctx = await deploy({ seller: repeat(450n, 5) });
    expect(await ctx.gate.clears(ctx.SELLER_AGENT_ID, ctx.POLICY)).to.equal(true);
    await ctx.reputation.connect(ctx.reviewers[0]).revokeFeedback(ctx.SELLER_AGENT_ID, 1);
    expect(await ctx.gate.clears(ctx.SELLER_AGENT_ID, ctx.POLICY)).to.equal(false);
  });

  it("refuses a policy that names no reviewers", async () => {
    const ctx = await deploy();
    await expect(
      ctx.gate.clears(ctx.BUYER_AGENT_ID, { ...ctx.POLICY, reviewers: [] }),
    ).to.be.revertedWithCustomError(ctx.gate, "EmptyReviewerSet");
  });

  it("refuses to let an address borrow another agent's reputation", async () => {
    const ctx = await deploy();
    expect(await ctx.gate.isAgentWallet(ctx.BUYER_AGENT_ID, ctx.outsider.address)).to.equal(false);
    await expect(
      ctx.gate.requireAdmitted(ctx.BUYER_AGENT_ID, ctx.outsider.address, ctx.POLICY),
    ).to.be.revertedWithCustomError(ctx.gate, "AgentWalletMismatch");
  });

  it("blocks a negotiation when either side fails the policy", async () => {
    const ctx = await deploy({ seller: repeat(500n, 1) });
    const deadline = BigInt(await time.latest()) + 3600n;
    await expect(
      ctx.sealed.createNegotiation(
        ctx.BUYER_AGENT_ID,
        ctx.buyer.address,
        ctx.SELLER_AGENT_ID,
        ctx.seller.address,
        deadline,
        ethers.ZeroHash,
        ctx.POLICY,
      ),
    ).to.be.revertedWithCustomError(ctx.gate, "NotAdmitted");
  });
});

describe("SealedNegotiation: the admission policy is stored", () => {
  it("stores the hash of the policy it checked in the negotiation, and emits it", async () => {
    const ctx = await deploy();
    const deadline = BigInt(await time.latest()) + 3600n;
    const terms = ethers.id("USD per unit, 1000 units, net 30");
    const expected = admissionPolicyHash(ctx.POLICY);

    await expect(
      ctx.sealed.createNegotiation(
        ctx.BUYER_AGENT_ID, ctx.buyer.address, ctx.SELLER_AGENT_ID, ctx.seller.address, deadline, terms, ctx.POLICY,
      ),
    )
      .to.emit(ctx.sealed, "NegotiationCreated")
      .withArgs(1n, ctx.buyer.address, ctx.seller.address, ctx.BUYER_AGENT_ID, ctx.SELLER_AGENT_ID, deadline, terms, expected);

    expect((await ctx.sealed.getNegotiation(1n)).policyHash).to.equal(expected);
    // The contract and the off-chain helper hash the policy the same way.
    expect(await ctx.sealed.admissionPolicyHash(ctx.POLICY)).to.equal(expected);
  });

  it("keeps each negotiation's own policy, so a looser one used later cannot be passed off as the first", async () => {
    const ctx = await deploy();
    const deadline = BigInt(await time.latest()) + 3600n;
    const looser = { ...ctx.POLICY, minFeedbackCount: 1n, minAverageValue: 100n };
    const open = (policy: typeof ctx.POLICY) =>
      ctx.sealed.createNegotiation(
        ctx.BUYER_AGENT_ID, ctx.buyer.address, ctx.SELLER_AGENT_ID, ctx.seller.address, deadline, ethers.ZeroHash, policy,
      );
    await open(ctx.POLICY);
    await open(looser);

    expect((await ctx.sealed.getNegotiation(1n)).policyHash).to.equal(admissionPolicyHash(ctx.POLICY));
    expect((await ctx.sealed.getNegotiation(2n)).policyHash).to.equal(admissionPolicyHash(looser));
    expect(admissionPolicyHash(looser)).to.not.equal(admissionPolicyHash(ctx.POLICY));
  });
});

describe("SealedNegotiation: what the chain can see", () => {
  it("leaks no offer value when a position is committed", async () => {
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);

    const offer = 1_000n;
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const commitment = await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, offer, salt);

    const tx = await ctx.sealed.connect(ctx.buyer).commitOffer(id, commitment);
    const receipt = await tx.wait();

    // The only event is OfferCommitted(negotiationId, party, commitIndex).
    // Neither the offer nor the salt appears anywhere in the logs.
    const encodedOffer = ethers.zeroPadValue(ethers.toBeHex(offer), 32).slice(2);
    for (const log of receipt!.logs) {
      expect(log.data.toLowerCase()).to.not.include(encodedOffer.toLowerCase());
      expect(log.data.toLowerCase()).to.not.include(salt.slice(2).toLowerCase());
    }
  });

  it("produces an unrelated commitment for the same offer in a later round", async () => {
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);
    const salt = ethers.hexlify(ethers.randomBytes(32));

    const round1 = await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, 1_000n, salt);
    const round2 = await ctx.sealed.commitmentHash(id, ctx.buyer.address, 2, 1_000n, salt);

    // An observer cannot tell whether the agent moved or held its position.
    expect(round1).to.not.equal(round2);
  });

  it("produces different commitments for the two parties on the same number", async () => {
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);
    const salt = ethers.hexlify(ethers.randomBytes(32));

    expect(await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, 900n, salt)).to.not.equal(
      await ctx.sealed.commitmentHash(id, ctx.seller.address, 1, 900n, salt),
    );
  });

  it("rejects a commitment from anyone who is not a party", async () => {
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);
    await expect(
      ctx.sealed.connect(ctx.outsider).commitOffer(id, ethers.id("whatever")),
    ).to.be.revertedWithCustomError(ctx.sealed, "NotAParty");
  });
});

describe("SealedNegotiation: settlement", () => {
  async function lockedPair(ctx: Awaited<ReturnType<typeof deploy>>, buyerOffer: bigint, sellerOffer: bigint) {
    const { id } = await openNegotiation(ctx);
    const buyerSalt = ethers.hexlify(ethers.randomBytes(32));
    const sellerSalt = ethers.hexlify(ethers.randomBytes(32));

    await ctx.sealed
      .connect(ctx.buyer)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, buyerOffer, buyerSalt));
    await ctx.sealed
      .connect(ctx.seller)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.seller.address, 1, sellerOffer, sellerSalt));

    return {
      id,
      buyerReveal: { offer: buyerOffer, salt: buyerSalt },
      sellerReveal: { offer: sellerOffer, salt: sellerSalt },
    };
  }

  it("locks once both sides have committed", async () => {
    const ctx = await deploy();
    const { id } = await lockedPair(ctx, 1_200n, 1_000n);
    expect((await ctx.sealed.getNegotiation(id)).status).to.equal(2); // Locked
  });

  it("settles at the midpoint when the positions clear", async () => {
    const ctx = await deploy();
    const { id, buyerReveal, sellerReveal } = await lockedPair(ctx, 1_200n, 1_000n);

    const buyerAuth = await authorize(ctx.sealed, ctx.buyer, id);
    const sellerAuth = await authorize(ctx.sealed, ctx.seller, id);

    await expect(ctx.sealed.settle(id, buyerReveal, sellerReveal, buyerAuth, sellerAuth))
      .to.emit(ctx.sealed, "NegotiationSettled")
      .withArgs(id, 1_100n);

    const n = await ctx.sealed.getNegotiation(id);
    expect(n.status).to.equal(3); // Settled
    expect(n.settledPrice).to.equal(1_100n);
  });

  it("can be submitted by a relayer, not just by a party", async () => {
    const ctx = await deploy();
    const { id, buyerReveal, sellerReveal } = await lockedPair(ctx, 500n, 400n);
    const buyerAuth = await authorize(ctx.sealed, ctx.buyer, id);
    const sellerAuth = await authorize(ctx.sealed, ctx.seller, id);

    await expect(
      ctx.sealed.connect(ctx.outsider).settle(id, buyerReveal, sellerReveal, buyerAuth, sellerAuth),
    ).to.emit(ctx.sealed, "NegotiationSettled");
  });

  it("refuses a settlement where the buyer's ceiling misses the seller's floor", async () => {
    const ctx = await deploy();
    const { id, buyerReveal, sellerReveal } = await lockedPair(ctx, 900n, 1_000n);
    const buyerAuth = await authorize(ctx.sealed, ctx.buyer, id);
    const sellerAuth = await authorize(ctx.sealed, ctx.seller, id);

    await expect(
      ctx.sealed.settle(id, buyerReveal, sellerReveal, buyerAuth, sellerAuth),
    ).to.be.revertedWithCustomError(ctx.sealed, "IncompatibleOffers");
  });

  it("refuses a disclosed offer that does not match what was committed", async () => {
    const ctx = await deploy();
    const { id, buyerReveal, sellerReveal } = await lockedPair(ctx, 1_200n, 1_000n);
    const buyerAuth = await authorize(ctx.sealed, ctx.buyer, id);
    const sellerAuth = await authorize(ctx.sealed, ctx.seller, id);

    const tampered = { offer: 1_500n, salt: buyerReveal.salt };
    await expect(
      ctx.sealed.settle(id, tampered, sellerReveal, buyerAuth, sellerAuth),
    ).to.be.revertedWithCustomError(ctx.sealed, "CommitmentMismatch");
  });
});

describe("SealedNegotiation: the properties that make it sealed", () => {
  it("cannot be settled unilaterally: one authorization is never enough", async () => {
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);
    const buyerSalt = ethers.hexlify(ethers.randomBytes(32));
    const sellerSalt = ethers.hexlify(ethers.randomBytes(32));

    await ctx.sealed
      .connect(ctx.buyer)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, 1_200n, buyerSalt));
    await ctx.sealed
      .connect(ctx.seller)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.seller.address, 1, 1_000n, sellerSalt));

    const buyerAuth = await authorize(ctx.sealed, ctx.buyer, id);
    // The buyer signs its own authorization twice and tries to pass it off as
    // the seller's. There is no path to settlement without the seller's key.
    await expect(
      ctx.sealed
        .connect(ctx.buyer)
        .settle(id, { offer: 1_200n, salt: buyerSalt }, { offer: 1_000n, salt: sellerSalt }, buyerAuth, buyerAuth),
    ).to.be.revertedWithCustomError(ctx.sealed, "BadAuthorization");
  });

  it("cannot be voided by a re-commit raced ahead of the settlement", async () => {
    // The attack: both sides committed and signed, the settlement is in the
    // mempool with both offers in its calldata, and the seller sends a new
    // commitment with a higher tip so it lands first. If that voided the
    // signatures, the settlement would revert with both offers already public.
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);
    const buyerSalt = ethers.hexlify(ethers.randomBytes(32));
    const sellerSalt1 = ethers.hexlify(ethers.randomBytes(32));
    const sellerSalt2 = ethers.hexlify(ethers.randomBytes(32));

    await ctx.sealed
      .connect(ctx.buyer)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, 1_200n, buyerSalt));
    await ctx.sealed
      .connect(ctx.seller)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.seller.address, 1, 1_000n, sellerSalt1));

    const buyerAuth = await authorize(ctx.sealed, ctx.buyer, id);
    const sellerAuth = await authorize(ctx.sealed, ctx.seller, id);
    const signedDigest = await ctx.sealed.settleAuthorizationDigest(id);

    // The front-run lands. It opens round 2 for the seller and leaves round 1 alone.
    await ctx.sealed
      .connect(ctx.seller)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.seller.address, 2, 1_150n, sellerSalt2));
    expect(await ctx.sealed.settleAuthorizationDigest(id)).to.equal(signedDigest);

    // The settlement that was already broadcast still goes through, at round 1's midpoint.
    await expect(
      ctx.sealed
        .connect(ctx.buyer)
        .settle(id, { offer: 1_200n, salt: buyerSalt }, { offer: 1_000n, salt: sellerSalt1 }, buyerAuth, sellerAuth),
    )
      .to.emit(ctx.sealed, "NegotiationSettled")
      .withArgs(id, 1_100n);
  });

  it("refuses a second commitment from a side that has not been matched yet", async () => {
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);
    const commit = async (who: any, index: number, offer: bigint) =>
      ctx.sealed
        .connect(who)
        .commitOffer(id, await ctx.sealed.commitmentHash(id, who.address, index, offer, ethers.id(`${index}${offer}`)));

    // Round 1: the buyer is in, the seller is not. The buyer cannot replace its round-1 commitment.
    await commit(ctx.buyer, 1, 1_200n);
    await expect(commit(ctx.buyer, 2, 1_300n)).to.be.revertedWithCustomError(ctx.sealed, "AlreadyCommitted").withArgs(1);

    // Round 1 complete, then the seller races ahead into round 2 and tries again.
    await commit(ctx.seller, 1, 1_000n);
    await commit(ctx.seller, 2, 1_150n);
    await expect(commit(ctx.seller, 3, 1_175n)).to.be.revertedWithCustomError(ctx.sealed, "AlreadyCommitted").withArgs(2);
  });

  it("voids the earlier authorizations once both sides have moved to a new round", async () => {
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);
    const salts = Array.from({ length: 4 }, () => ethers.hexlify(ethers.randomBytes(32)));
    const commit = async (who: any, index: number, offer: bigint, salt: string) =>
      ctx.sealed.connect(who).commitOffer(id, await ctx.sealed.commitmentHash(id, who.address, index, offer, salt));

    // Round 1 does not cross. Both sign anyway, as the relay asks every round.
    await commit(ctx.buyer, 1, 900n, salts[0]);
    await commit(ctx.seller, 1, 1_000n, salts[1]);
    const round1Auths = [await authorize(ctx.sealed, ctx.buyer, id), await authorize(ctx.sealed, ctx.seller, id)];

    // Both move on. Round 2 is now the pair the contract will settle, and nothing else.
    await commit(ctx.buyer, 2, 1_200n, salts[2]);
    await commit(ctx.seller, 2, 1_100n, salts[3]);
    await expect(
      ctx.sealed.settle(id, { offer: 900n, salt: salts[0] }, { offer: 1_000n, salt: salts[1] }, round1Auths[0], round1Auths[1]),
    ).to.be.revertedWithCustomError(ctx.sealed, "CommitmentMismatch");

    const round2Auths = [await authorize(ctx.sealed, ctx.buyer, id), await authorize(ctx.sealed, ctx.seller, id)];
    await expect(
      ctx.sealed.settle(id, { offer: 1_200n, salt: salts[2] }, { offer: 1_100n, salt: salts[3] }, round2Auths[0], round2Auths[1]),
    )
      .to.emit(ctx.sealed, "NegotiationSettled")
      .withArgs(id, 1_150n);
  });

  it("cannot be replayed against another deployment of the same contract", async () => {
    const ctx = await deploy();
    const { id } = await openNegotiation(ctx);

    const other = await (await ethers.getContractFactory("SealedNegotiation")).deploy(await ctx.gate.getAddress());
    const salt = ethers.hexlify(ethers.randomBytes(32));

    // Same negotiation id, same party, same round, same offer, same salt.
    expect(await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, 1_000n, salt)).to.not.equal(
      await other.commitmentHash(id, ctx.buyer.address, 1, 1_000n, salt),
    );
  });

  it("expires without ever putting either position on-chain", async () => {
    const ctx = await deploy();
    const { id, deadline } = await openNegotiation(ctx);
    const buyerSalt = ethers.hexlify(ethers.randomBytes(32));
    const sellerSalt = ethers.hexlify(ethers.randomBytes(32));

    // Two agents whose positions do not clear. They exchange reveals with each
    // other, both learn there is no deal, and nobody submits a settlement.
    await ctx.sealed
      .connect(ctx.buyer)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, 900n, buyerSalt));
    await ctx.sealed
      .connect(ctx.seller)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.seller.address, 1, 1_400n, sellerSalt));

    await time.increaseTo(deadline);
    const receipt = await (await ctx.sealed.expire(id)).wait();

    expect((await ctx.sealed.getNegotiation(id)).status).to.equal(4); // Expired
    expect((await ctx.sealed.getNegotiation(id)).settledPrice).to.equal(0n);

    // Nothing in the failure path carries a number either agent cared about.
    for (const log of receipt!.logs) {
      expect(log.data.toLowerCase()).to.not.include(buyerSalt.slice(2).toLowerCase());
      expect(log.data.toLowerCase()).to.not.include(sellerSalt.slice(2).toLowerCase());
    }
  });

  it("cannot be settled after the deadline", async () => {
    const ctx = await deploy();
    const { id, deadline } = await openNegotiation(ctx);
    const buyerSalt = ethers.hexlify(ethers.randomBytes(32));
    const sellerSalt = ethers.hexlify(ethers.randomBytes(32));

    await ctx.sealed
      .connect(ctx.buyer)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.buyer.address, 1, 1_200n, buyerSalt));
    await ctx.sealed
      .connect(ctx.seller)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.seller.address, 1, 1_000n, sellerSalt));

    const buyerAuth = await authorize(ctx.sealed, ctx.buyer, id);
    const sellerAuth = await authorize(ctx.sealed, ctx.seller, id);

    await time.increaseTo(deadline);
    await expect(
      ctx.sealed.settle(id, { offer: 1_200n, salt: buyerSalt }, { offer: 1_000n, salt: sellerSalt }, buyerAuth, sellerAuth),
    ).to.be.revertedWithCustomError(ctx.sealed, "DeadlinePassed");
  });
});
