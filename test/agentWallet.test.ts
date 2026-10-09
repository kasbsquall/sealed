import { expect } from "chai";
import { AgentWallet } from "../agents/privy/agentWallet";

/** Stands in for the Privy client and keeps what the wallet would send to it. */
function fakePrivy(sent: unknown[]) {
  return {
    wallets: () => ({
      ethereum: () => ({
        signTypedData: async (_walletId: string, body: unknown) => {
          sent.push(body);
          return { signature: "0x" };
        },
      }),
    }),
  } as any;
}

describe("Privy agent wallet", () => {
  it("sends Privy a settlement authorization that serializes to JSON", async () => {
    const sent: unknown[] = [];
    const wallet = new AgentWallet({
      privy: fakePrivy(sent),
      walletId: "w",
      address: "0x0000000000000000000000000000000000000001",
      domain: { chainId: 10143n, verifyingContract: "0x00000000000000000000000000000000000000aa" },
      authorizationPrivateKey: "k",
      broadcast: "privy",
    });

    await wallet.authorizeSettlement({
      negotiationId: 7n,
      buyerCommitment: "0x" + "11".repeat(32),
      sellerCommitment: "0x" + "22".repeat(32),
      buyerCommitIndex: 1,
      sellerCommitIndex: 1,
    });

    // Privy's SDK serializes the request; a bigint anywhere in it throws.
    const json = JSON.parse(JSON.stringify(sent[0]));
    expect(json.params.typed_data.domain.chainId).to.equal(10143);
    expect(json.params.typed_data.message.negotiationId).to.equal("7");
  });
});
