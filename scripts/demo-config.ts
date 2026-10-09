/**
 * The demo negotiation, shared by the single-process and the separated runs.
 * The contract stores only keccak256 of this text as `termsSchema`, so both
 * agents can check they are negotiating the same thing.
 */
export const TERMS = "Demo: price per 1,000 calls to a market-data API, 30-day term, in US cents";
export const UNIT = "US cents per 1,000 API calls";
export const REFERENCE = 4000n;
export const MAX_ROUNDS = 3;

export const SCENARIOS = {
  deal: { buyerLimit: 4300n, sellerLimit: 4100n, windowSeconds: 900 },
  // Three rounds of tool-using agents, commits and signatures. At 300 s the first
  // run finished 16 s before its deadline; at 420 s the second missed it in round 3,
  // with Qwen 3.8 Max taking about two minutes a round. Same window as the deal.
  "no-deal": { buyerLimit: 3600n, sellerLimit: 4300n, windowSeconds: 900 },
} as const;
export type ScenarioName = keyof typeof SCENARIOS;
