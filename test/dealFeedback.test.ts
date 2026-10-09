import { expect } from "chai";
import { feedbackFor } from "../agents/sealed/dealFeedback";

const deal = {
  negotiationId: 8n,
  buyerWallet: "0x00000000000000000000000000000000000000B1",
  sellerWallet: "0x00000000000000000000000000000000000000A2",
  buyerAgentId: 2093n,
  sellerAgentId: 2094n,
};
const SETTLE = "0x" + "ab".repeat(32);

describe("Deal feedback", () => {
  it("rates the other party of the deal, from either side, and points at the settlement", () => {
    expect(feedbackFor(deal, deal.buyerWallet.toLowerCase(), SETTLE, 10143).agentId).to.equal(2094n);
    const fromSeller = feedbackFor(deal, deal.sellerWallet, SETTLE, 10143n);
    expect(fromSeller).to.include({ agentId: 2093n, feedbackHash: SETTLE, tag1: "sealed", tag2: "settled", feedbackURI: `eip155:10143:tx:${SETTLE}` });
  });

  it("refuses a reviewer who was not a party to the deal", () => {
    expect(() => feedbackFor(deal, "0x00000000000000000000000000000000000000C3", SETTLE, 10143)).to.throw(/not a party/);
  });
});
