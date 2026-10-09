import fs from "fs";
import path from "path";

/**
 * Everything the page shows comes from files committed in the repo, read at
 * build time: the demo transcripts in demo-runs/ and the deployment record in
 * deployments/. Nothing on the page is typed by hand.
 */

const ROOT = path.join(process.cwd(), "..");

export interface Side {
  offer: string;
  proposedOffer?: string;
  correction?: "limit" | "no-backtracking";
  stance: string;
  explanation: string;
  commitIndex: number;
  commitment: string;
  commitTx: string;
  salt: string;
}

export interface Round {
  round: number;
  buyer: Side;
  seller: Side;
  crossed: boolean;
}

export interface Run {
  scenario: "deal" | "no-deal";
  chainId: number;
  contract: string;
  relay: string;
  model: string;
  /** "local (…)" when the model ran on the operator's machine, otherwise the API base URL. */
  modelHost?: string;
  terms: string;
  referencePrice: string;
  agents: Record<"buyer" | "seller", { agentId: string; wallet: string; limit: string }>;
  negotiationId: string;
  createTx: string;
  deadline: string;
  rounds: Round[];
  outcome: "settled" | "expired" | "aborted";
  settleTx?: string;
  expireTx?: string;
  settledPrice?: string;
  file: string;
}

export interface Deployment {
  chainId: number;
  registries: { identity: string; reputation: string };
  contracts: { ReputationGate: string; SealedNegotiation: string };
  agents: Record<"buyer" | "seller" | "newcomer", { agentId: string; wallet: string }>;
  policy: { reviewers: string[]; minFeedbackCount: number; minAverageValue: number; decimals: number };
  admission: Record<"buyer" | "seller" | "newcomer", { clears: boolean }>;
  feedback: Record<"buyer" | "seller" | "newcomer", string[]>;
}

const read = <T,>(...parts: string[]): T => JSON.parse(fs.readFileSync(path.join(ROOT, ...parts), "utf8"));

/** The transcript in demo-runs/ with the highest negotiation id whose name matches, if there is one. */
function latest(pattern: RegExp): Run | undefined {
  const dir = path.join(ROOT, "demo-runs");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const [best] = files
    .map((file) => ({ file, id: pattern.exec(file)?.[1] }))
    .filter((f): f is { file: string; id: string } => f.id !== undefined)
    .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0));
  return best && { ...read<Omit<Run, "file">>("demo-runs", best.file), file: `demo-runs/${best.file}` };
}

/** The latest deal and the latest no-deal run on Monad testnet. Either is undefined until it has been recorded. */
export function loadRuns(): { deal?: Run; noDeal?: Run } {
  return {
    deal: latest(/^monadTestnet-deal-(\d+)\.json$/),
    noDeal: latest(/^monadTestnet-no-deal-(\d+)\.json$/),
  };
}

export function loadDeployment(): Deployment {
  return read<Deployment>("deployments", "monadTestnet.json");
}

/** The deal scenario with referee and agents as separate processes, cited as evidence in the limits when it exists. */
export function loadSeparated(): Run | undefined {
  return latest(/^monadTestnet-deal-(\d+)-separated\.json$/);
}
