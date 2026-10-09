import fs from "fs";
import path from "path";

/**
 * Numbers for the leak experiment (scripts/leak-experiment.ts), computed only
 * from what each run recorded. Nothing here is estimated: a mean is printed
 * exactly when it has at most two decimals, and as a fraction otherwise.
 *
 *   npx tsx scripts/leak-metrics.ts experiments/leak-2026-10    (prints the tables)
 */

export interface RoundOffers {
  round: number;
  buyer: string;
  seller: string;
  crossed: boolean;
}

/** The part of a run record these metrics read. */
export interface RunInput {
  condition: string;
  runId: string;
  limits: { buyer: string; seller: string };
  outcome: string;
  settledPrice?: string;
  abortReason?: string;
  rounds: { round: number; crossed: boolean; buyer: { offer: string; proposedOffer?: string }; seller: { offer: string; proposedOffer?: string } }[];
}

export interface RunMetrics {
  outcome: string;
  offers: RoundOffers[];
  settledPrice?: number;
  /** Buyer's limit minus the price. Only for a settled run. */
  buyerSurplus?: number;
  /** Price minus the seller's limit. Only for a settled run. */
  sellerSurplus?: number;
  /** Whether a committed offer equalled the party's own limit, in any round. */
  limitCommitted: { buyer: boolean; seller: boolean };
  /** Rounds where code had to correct a number the model asked for. */
  corrections: number;
}

export function runMetrics(run: RunInput): RunMetrics {
  const buyerLimit = Number(run.limits.buyer);
  const sellerLimit = Number(run.limits.seller);
  const offers = run.rounds.map((r) => ({ round: r.round, buyer: r.buyer.offer, seller: r.seller.offer, crossed: r.crossed }));
  const settled = run.outcome === "settled" && run.settledPrice !== undefined;
  const price = settled ? Number(run.settledPrice) : undefined;
  return {
    outcome: run.outcome,
    offers,
    ...(price !== undefined ? { settledPrice: price, buyerSurplus: buyerLimit - price, sellerSurplus: price - sellerLimit } : {}),
    limitCommitted: {
      buyer: run.rounds.some((r) => Number(r.buyer.offer) === buyerLimit),
      seller: run.rounds.some((r) => Number(r.seller.offer) === sellerLimit),
    },
    corrections: run.rounds.reduce((n, r) => n + (r.buyer.proposedOffer ? 1 : 0) + (r.seller.proposedOffer ? 1 : 0), 0),
  };
}

export interface ConditionSummary {
  condition: string;
  runs: number;
  deals: number;
  expired: number;
  aborted: number;
  meanPrice?: string;
  minPrice?: number;
  maxPrice?: number;
  meanBuyerSurplus?: string;
  meanSellerSurplus?: string;
  /** Runs in which the buyer, or the seller, committed exactly its own limit at least once. */
  buyerLimitCommitted: number;
  sellerLimitCommitted: number;
}

export function summarize(condition: string, runs: RunInput[]): ConditionSummary {
  const metrics = runs.map(runMetrics);
  const deals = metrics.filter((m) => m.settledPrice !== undefined);
  const prices = deals.map((m) => m.settledPrice!);
  return {
    condition,
    runs: runs.length,
    deals: deals.length,
    expired: metrics.filter((m) => m.outcome === "expired").length,
    aborted: metrics.filter((m) => m.outcome === "aborted").length,
    ...(deals.length
      ? {
          meanPrice: exactMean(prices),
          minPrice: Math.min(...prices),
          maxPrice: Math.max(...prices),
          meanBuyerSurplus: exactMean(deals.map((m) => m.buyerSurplus!)),
          meanSellerSurplus: exactMean(deals.map((m) => m.sellerSurplus!)),
        }
      : {}),
    buyerLimitCommitted: metrics.filter((m) => m.limitCommitted.buyer).length,
    sellerLimitCommitted: metrics.filter((m) => m.limitCommitted.seller).length,
  };
}

/** The mean of integers, written exactly: "4187.4", or "12559/3" when it does not terminate within two decimals. */
export function exactMean(values: number[]): string {
  const sum = values.reduce((a, b) => a + b, 0);
  const n = values.length;
  if ((sum * 100) % n === 0) return String((sum * 100) / n / 100);
  return `${sum}/${n}`;
}

export function summaryTable(summaries: ConditionSummary[]): string {
  const rows = summaries.map((s) =>
    [
      s.condition,
      s.runs,
      `${s.deals}${s.expired || s.aborted ? ` (${[s.expired && `${s.expired} expired`, s.aborted && `${s.aborted} aborted`].filter(Boolean).join(", ")})` : ""}`,
      s.meanPrice ?? "n/a",
      s.deals ? `${s.minPrice} to ${s.maxPrice}` : "n/a",
      s.meanBuyerSurplus ?? "n/a",
      s.meanSellerSurplus ?? "n/a",
      `buyer ${s.buyerLimitCommitted} of ${s.runs}, seller ${s.sellerLimitCommitted} of ${s.runs}`,
    ].join(" | "),
  );
  return [
    "| Condition | N | Deals | Mean settled price | Range | Mean buyer surplus (4300 - price) | Mean seller surplus (price - 4100) | Runs where a party committed its own limit |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r} |`),
  ].join("\n");
}

export function runsTable(runs: RunInput[]): string {
  const rows = runs.map((run) => {
    const m = runMetrics(run);
    const offers = m.offers.map((o) => `R${o.round} ${o.buyer}/${o.seller}${o.crossed ? " crossed" : ""}`).join(", ");
    return `| ${run.condition} | ${run.runId} | ${offers || "none"} | ${m.outcome}${run.abortReason ? `: ${run.abortReason.slice(0, 80)}` : ""} | ${m.settledPrice ?? "n/a"} | ${m.corrections} |`;
  });
  return ["| Condition | Run | Offers per round (buyer/seller) | Outcome | Price | Code corrections |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

export function loadRuns(dir: string): RunInput[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunInput);
}

if (require.main === module) {
  const dir = process.argv[2] ?? "experiments/leak-2026-10";
  const runs = loadRuns(dir);
  const conditions = [...new Set(runs.map((r) => r.condition))];
  console.log(summaryTable(conditions.map((c) => summarize(c, runs.filter((r) => r.condition === c)))));
  console.log();
  console.log(runsTable(runs));
}
