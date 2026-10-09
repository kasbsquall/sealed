import { expect } from "chai";
import { exactMean, runMetrics, summarize, summaryTable, type RunInput } from "../scripts/leak-metrics";

const side = (offer: number, proposedOffer?: number) => ({ offer: String(offer), ...(proposedOffer ? { proposedOffer: String(proposedOffer) } : {}) });
const run = (runId: string, outcome: string, rounds: [number, number, boolean][], settledPrice?: string, corrected = false): RunInput => ({
  condition: "sealed",
  runId,
  limits: { buyer: "4300", seller: "4100" },
  outcome,
  ...(settledPrice ? { settledPrice } : {}),
  rounds: rounds.map(([b, s, crossed], i) => ({ round: i + 1, crossed, buyer: side(b, corrected && i === 0 ? 4400 : undefined), seller: side(s) })),
});

describe("Leak experiment metrics", () => {
  it("derives surplus and whether a limit was committed from the recorded offers", () => {
    const m = runMetrics(run("1", "settled", [[3800, 4600, false], [4300, 4150, true]], "4225"));
    expect(m.settledPrice).to.equal(4225);
    expect(m.buyerSurplus).to.equal(75);
    expect(m.sellerSurplus).to.equal(125);
    expect(m.limitCommitted).to.deep.equal({ buyer: true, seller: false });
    expect(m.offers[1]).to.deep.equal({ round: 2, buyer: "4300", seller: "4150", crossed: true });
  });

  it("gives no price or surplus for a run that did not settle, and counts code corrections", () => {
    const m = runMetrics(run("2", "expired", [[4300, 4400, false], [4300, 4350, false]], undefined, true));
    expect(m).to.not.have.property("settledPrice");
    expect(m).to.not.have.property("buyerSurplus");
    expect(m.corrections).to.equal(1);
  });

  it("summarizes a condition over its deals only, and counts every run", () => {
    const s = summarize("sealed", [
      run("1", "settled", [[4250, 4130, true]], "4190"),
      run("2", "settled", [[4200, 4100, true]], "4150"),
      run("3", "aborted", []),
    ]);
    expect(s).to.include({ runs: 3, deals: 2, aborted: 1, expired: 0, meanPrice: "4170", minPrice: 4150, maxPrice: 4190 });
    expect(s).to.include({ meanBuyerSurplus: "130", meanSellerSurplus: "70", buyerLimitCommitted: 0, sellerLimitCommitted: 1 });
    expect(summaryTable([s])).to.include("| sealed | 3 | 2 (1 aborted) | 4170 | 4150 to 4190 | 130 | 70 | buyer 0 of 3, seller 1 of 3 |");
  });

  it("writes a mean exactly, as a fraction when it does not end within two decimals", () => {
    expect(exactMean([4190, 4185])).to.equal("4187.5");
    expect(exactMean([4190, 4185, 4184])).to.equal("12559/3");
  });
});
