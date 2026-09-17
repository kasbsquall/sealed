import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HDNodeWallet } from "ethers";

const BUYER_AGENT_ID = 1n;
const SELLER_AGENT_ID = 2n;

// Policy: at least 5 feedback entries, average of at least 4.0 with 2 decimals.
const POLICY = {
  minFeedbackCount: 5n,
  minAverageValue: 400n,
  decimals: 2,
  tag1: "",
};

async function deploy() {
  const [deployer, buyer, seller, outsider] = await ethers.getSigners();

  const identity = await (await ethers.getContractFactory("MockIdentityRegistry")).deploy();
  const reputation = await (await ethers.getContractFactory("MockReputationRegistry")).deploy();

  await identity.register(BUYER_AGENT_ID, buyer.address);
  await identity.register(SELLER_AGENT_ID, seller.address);
  await reputation.setSummary(BUYER_AGENT_ID, 12, 470, 2);
  await reputation.setSummary(SELLER_AGENT_ID, 8, 430, 2);

  const gate = await (
    await ethers.getContractFactory("ReputationGate")
  ).deploy(await identity.getAddress(), await reputation.getAddress());

  const sealed = await (
    await ethers.getContractFactory("SealedNegotiation")
  ).deploy(await gate.getAddress());

  return { deployer, buyer, seller, outsider, identity, reputation, gate, sealed };
}

async function openNegotiation(ctx: Awaited<ReturnType<typeof deploy>>, hours = 24) {
  const deadline = BigInt(await time.latest()) + BigInt(hours * 3600);
  await ctx.sealed.createNegotiation(
    BUYER_AGENT_ID,
    ctx.buyer.address,
    SELLER_AGENT_ID,
    ctx.seller.address,
    deadline,
    ethers.id("USD per unit, 1000 units, net 30"),
    POLICY,
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
    expect(await ctx.gate.clears(BUYER_AGENT_ID, POLICY)).to.equal(true);
  });

  it("rejects an agent with a good average but too little history", async () => {
    const ctx = await deploy();
    await ctx.reputation.setSummary(SELLER_AGENT_ID, 2, 500, 2);
    expect(await ctx.gate.clears(SELLER_AGENT_ID, POLICY)).to.equal(false);
  });

  it("rejects an agent whose average is below the bar", async () => {
    const ctx = await deploy();
    await ctx.reputation.setSummary(SELLER_AGENT_ID, 40, 310, 2);
    expect(await ctx.gate.clears(SELLER_AGENT_ID, POLICY)).to.equal(false);
  });

  it("refuses to let an address borrow another agent's reputation", async () => {
    const ctx = await deploy();
    expect(await ctx.gate.isAgentWallet(BUYER_AGENT_ID, ctx.outsider.address)).to.equal(false);
    await expect(
      ctx.gate.requireAdmitted(BUYER_AGENT_ID, ctx.outsider.address, POLICY),
    ).to.be.revertedWithCustomError(ctx.gate, "AgentWalletMismatch");
  });

  it("blocks a negotiation when either side fails the policy", async () => {
    const ctx = await deploy();
    await ctx.reputation.setSummary(SELLER_AGENT_ID, 1, 500, 2);
    const deadline = BigInt(await time.latest()) + 3600n;
    await expect(
      ctx.sealed.createNegotiation(
        BUYER_AGENT_ID,
        ctx.buyer.address,
        SELLER_AGENT_ID,
        ctx.seller.address,
        deadline,
        ethers.ZeroHash,
        POLICY,
      ),
    ).to.be.revertedWithCustomError(ctx.gate, "NotAdmitted");
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

  it("voids both authorizations the moment either side re-commits", async () => {
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

    // The seller withdraws that position and commits a higher floor.
    await ctx.sealed
      .connect(ctx.seller)
      .commitOffer(id, await ctx.sealed.commitmentHash(id, ctx.seller.address, 2, 1_150n, sellerSalt2));

    // The buyer, holding the earlier pair, cannot force the old deal through.
    await expect(
      ctx.sealed
        .connect(ctx.buyer)
        .settle(id, { offer: 1_200n, salt: buyerSalt }, { offer: 1_000n, salt: sellerSalt1 }, buyerAuth, sellerAuth),
    ).to.be.revertedWithCustomError(ctx.sealed, "CommitmentMismatch");
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
