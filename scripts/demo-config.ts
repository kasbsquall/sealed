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
  "no-deal": { buyerLimit: 3600n, sellerLimit: 4300n, windowSeconds: 150 },
} as const;
export type ScenarioName = keyof typeof SCENARIOS;
