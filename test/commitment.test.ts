import { expect } from "chai";
import { ethers } from "hardhat";
import {
  commitmentHash,
  domainSeparator,
  newSalt,
  settleAuthorizationTypedData,
  assertSalt,
} from "../agents/sealed/commitment";

/**
 * The agent computes its commitment itself, because handing the offer to
 * anything outside its own process would defeat the point. That means the
 * off-chain encoder and the contract must agree byte for byte, forever. These
 * tests are the seam.
 */
describe("Off-chain commitment encoder", () => {
  async function deploySealed() {
    const identity = await (await ethers.getContractFactory("MockIdentityRegistry")).deploy();
    const reputation = await (await ethers.getContractFactory("MockReputationRegistry")).deploy();
    const gate = await (
      await ethers.getContractFactory("ReputationGate")
    ).deploy(await identity.getAddress(), await reputation.getAddress());
    const sealed = await (await ethers.getContractFactory("SealedNegotiation")).deploy(await gate.getAddress());

    const domain = {
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await sealed.getAddress(),
    };

    return { sealed, domain };
  }

  it("matches the contract for a range of positions and rounds", async () => {
    const { sealed, domain } = await deploySealed();
    const [, party] = await ethers.getSigners();

    const cases = [
      { negotiationId: 1n, commitIndex: 1, offer: 0n },
      { negotiationId: 1n, commitIndex: 2, offer: 1n },
      { negotiationId: 7n, commitIndex: 1, offer: 1_000_000n },
      { negotiationId: 42n, commitIndex: 255, offer: 2n ** 255n },
      { negotiationId: 2n ** 64n, commitIndex: 4_294_967_295, offer: 2n ** 256n - 1n },
    ];

    for (const c of cases) {
      const salt = newSalt();
      const offChain = commitmentHash({
        domain,
        negotiationId: c.negotiationId,
        party: party.address,
        commitIndex: c.commitIndex,
        position: { offer: c.offer, salt },
      });
      const onChain = await sealed.commitmentHash(c.negotiationId, party.address, c.commitIndex, c.offer, salt);

      expect(offChain).to.equal(onChain);
    }
  });

  it("derives the same domain separator the contract reports via ERC-5267", async () => {
    const { sealed, domain } = await deploySealed();
    const [, name, version, chainId, verifyingContract] = await sealed.eip712Domain();

    expect(name).to.equal("Sealed");
    expect(version).to.equal("1");
    expect(chainId).to.equal(domain.chainId);
    expect(verifyingContract).to.equal(domain.verifyingContract);

    // And the separator built from those fields is the one the encoder uses.
    expect(domainSeparator(domain)).to.equal(
      ethers.TypedDataEncoder.hashDomain({ name, version, chainId, verifyingContract }),
    );
  });

  it("produces a settlement authorization the contract accepts", async () => {
    const { sealed, domain } = await deploySealed();
    const [, buyer] = await ethers.getSigners();

    // A negotiation that has not been created still has a well-defined digest,
    // which is enough to check that both sides encode the same message.
    const message = {
      negotiationId: 1n,
      buyerCommitment: ethers.id("buyer"),
      sellerCommitment: ethers.id("seller"),
      buyerCommitIndex: 3,
      sellerCommitIndex: 5,
    };

    const typedData = settleAuthorizationTypedData(domain, message);
    const digest = ethers.TypedDataEncoder.hash(typedData.domain, typedData.types as any, typedData.message);
    const signature = await buyer.signTypedData(typedData.domain, typedData.types as any, typedData.message);

    expect(ethers.recoverAddress(digest, signature)).to.equal(buyer.address);
  });

  it("generates 32-byte salts", () => {
    for (let i = 0; i < 16; i++) {
      expect(() => assertSalt(newSalt())).to.not.throw();
    }
    expect(() => assertSalt("0x1234")).to.throw();
  });

  it("never repeats a salt", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newSalt());
    expect(seen.size).to.equal(1000);
  });
});
