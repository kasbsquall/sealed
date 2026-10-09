import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  ZeroAddress,
  dataLength,
  dataSlice,
  getAddress,
  toBigInt,
  type Provider,
} from "ethers";
import { MONAD_TESTNET, type Policy, type SealedDeployment } from "./addresses";
import { IDENTITY_REGISTRY_ABI, REPUTATION_GATE_ABI, REPUTATION_REGISTRY_ABI, SEALED_NEGOTIATION_ABI } from "./abis";
import { verifySettlement, type SettlementReport, type VerifyOptions } from "./verify";

export const NEGOTIATION_STATUSES = ["None", "Open", "Locked", "Settled", "Expired"] as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number] | "Unknown";

/** `getNegotiation(id)` as stored on-chain. */
export interface Negotiation {
  negotiationId: bigint;
  /** "None" means no negotiation with this id exists. */
  status: NegotiationStatus;
  buyerWallet: string;
  sellerWallet: string;
  buyerAgentId: bigint;
  sellerAgentId: bigint;
  buyerCommitment: string;
  sellerCommitment: string;
  buyerCommitIndex: number;
  sellerCommitIndex: number;
  /** Unix seconds. */
  deadline: bigint;
  /** Zero until Settled. */
  settledPrice: bigint;
  termsSchema: string;
  /**
   * Raw 32-byte words returned after the twelve fields above. Empty on the
   * current deployment; a later contract version appends its new fields here.
   */
  extra: string[];
}

export interface AdmissionResult {
  agentId: bigint;
  /** The wallet ERC-8004 has on record for the agent, or null when none is set. */
  registeredWallet: string | null;
  /** The wallet that was checked: the one given, or the registered one. */
  wallet: string | null;
  isAgentWallet: boolean;
  /** Whether the agent clears the policy. Null when the gate refused to evaluate it. */
  clears: boolean | null;
  /** True only when both checks pass: what createNegotiation would require. */
  admitted: boolean;
  /** Why `clears` is null, e.g. a decimals mismatch. */
  error?: string;
  policy: Policy;
}

export interface ReputationSummary {
  agentId: bigint;
  reviewers: readonly string[];
  tag1: string;
  tag2: string;
  /** Non-revoked entries from these reviewers. */
  count: bigint;
  /** Average in `decimals` fixed point, as the registry returns it. */
  average: bigint;
  decimals: number;
  /** `average` as a decimal string, e.g. "4.70". */
  averageText: string;
}

export interface ReadClientOptions {
  /** Defaults to the deployment's public RPC. Ignored when `provider` is given. */
  rpcUrl?: string;
  provider?: Provider;
  deployment?: SealedDeployment;
}

const V1_WORDS = 12;
const V1_LAYOUT = ["address", "address", "uint256", "uint256", "bytes32", "bytes32", "uint32", "uint32", "uint64", "uint8", "uint256", "bytes32"];
const sealedInterface = new Interface(SEALED_NEGOTIATION_ABI);

/**
 * Decodes the return data of `getNegotiation`, reading the twelve fields of
 * the current layout and keeping any words after them in `extra`, so that a
 * contract version with a field appended still decodes.
 */
export function decodeNegotiation(negotiationId: bigint, returnData: string): Negotiation {
  let data = returnData;
  // A struct that gained a dynamic field is returned behind a 32-byte offset.
  if (dataLength(data) > V1_WORDS * 32 && toBigInt(dataSlice(data, 0, 32)) === 32n) data = dataSlice(data, 32);
  if (dataLength(data) < V1_WORDS * 32) throw new Error(`getNegotiation returned ${dataLength(data)} bytes, expected at least ${V1_WORDS * 32}`);
  const v = AbiCoder.defaultAbiCoder().decode(V1_LAYOUT, dataSlice(data, 0, V1_WORDS * 32));
  const extra: string[] = [];
  for (let offset = V1_WORDS * 32; offset + 32 <= dataLength(data); offset += 32) extra.push(dataSlice(data, offset, offset + 32));
  const statusCode = Number(v[9]);
  return {
    negotiationId,
    status: NEGOTIATION_STATUSES[statusCode] ?? "Unknown",
    buyerWallet: v[0],
    sellerWallet: v[1],
    buyerAgentId: v[2],
    sellerAgentId: v[3],
    buyerCommitment: v[4],
    sellerCommitment: v[5],
    buyerCommitIndex: Number(v[6]),
    sellerCommitIndex: Number(v[7]),
    deadline: v[8],
    settledPrice: v[10],
    termsSchema: v[11],
    extra,
  };
}

export function formatFixed(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

const revertReason = (error: unknown) =>
  (error as { shortMessage?: string })?.shortMessage ?? (error instanceof Error ? error.message : String(error));

/** Read-only access to a Sealed deployment and the ERC-8004 registries it reads. No keys. */
export class SealedReader {
  readonly provider: Provider;
  readonly deployment: SealedDeployment;
  readonly sealed: Contract;
  readonly gate: Contract;
  readonly identity: Contract;
  readonly reputation: Contract;

  constructor(options: ReadClientOptions = {}) {
    this.deployment = options.deployment ?? MONAD_TESTNET;
    this.provider =
      options.provider ??
      new JsonRpcProvider(options.rpcUrl ?? this.deployment.rpcUrl, this.deployment.chainId, { staticNetwork: true });
    this.sealed = new Contract(this.deployment.sealedNegotiation, SEALED_NEGOTIATION_ABI, this.provider);
    this.gate = new Contract(this.deployment.reputationGate, REPUTATION_GATE_ABI, this.provider);
    this.identity = new Contract(this.deployment.identityRegistry, IDENTITY_REGISTRY_ABI, this.provider);
    this.reputation = new Contract(this.deployment.reputationRegistry, REPUTATION_REGISTRY_ABI, this.provider);
  }

  async negotiationCount(): Promise<bigint> {
    return this.sealed.negotiationCount();
  }

  /** Reads one negotiation. Tolerates fields a later contract version appends. */
  async getNegotiation(negotiationId: bigint | number | string, contract = this.deployment.sealedNegotiation): Promise<Negotiation> {
    const id = BigInt(negotiationId);
    const data = await this.provider.call({ to: contract, data: sealedInterface.encodeFunctionData("getNegotiation", [id]) });
    return decodeNegotiation(id, data);
  }

  /** Each side's current commit index. The next commit of a side is its index plus one. */
  async getCommitIndices(negotiationId: bigint | number | string): Promise<{ buyer: number; seller: number }> {
    const n = await this.getNegotiation(negotiationId);
    return { buyer: n.buyerCommitIndex, seller: n.sellerCommitIndex };
  }

  /**
   * Whether an agent would be admitted under `policy` (the demo policy by
   * default): its wallet must be the one ERC-8004 has on record, and it must
   * clear the policy in ReputationGate.
   */
  async checkAdmission(agentId: bigint | number | string, options: { policy?: Policy; wallet?: string } = {}): Promise<AdmissionResult> {
    const id = BigInt(agentId);
    const policy = options.policy ?? this.deployment.demoPolicy;
    const recorded: string = await this.identity.getAgentWallet(id);
    const registeredWallet = recorded === ZeroAddress ? null : getAddress(recorded);
    const wallet = options.wallet ? getAddress(options.wallet) : registeredWallet;
    const isAgentWallet = wallet ? Boolean(await this.gate.isAgentWallet(id, wallet)) : false;
    let clears: boolean | null = null;
    let error: string | undefined;
    try {
      clears = Boolean(await this.gate.clears(id, policyTuple(policy)));
    } catch (e) {
      error = revertReason(e);
    }
    return { agentId: id, registeredWallet, wallet, isAgentWallet, clears, admitted: isAgentWallet && clears === true, policy, ...(error ? { error } : {}) };
  }

  /** ERC-8004 getSummary over the given reviewers (the demo policy's trusted reviewers by default). */
  async readReputation(
    agentId: bigint | number | string,
    options: { reviewers?: readonly string[]; tag1?: string; tag2?: string } = {},
  ): Promise<ReputationSummary> {
    const id = BigInt(agentId);
    const reviewers = options.reviewers ?? this.deployment.demoPolicy.reviewers;
    if (reviewers.length === 0) throw new Error("ERC-8004 needs at least one reviewer: reputation from anyone at all is Sybil-farmable");
    const tag1 = options.tag1 ?? "";
    const tag2 = options.tag2 ?? "";
    const [count, average, decimals] = await this.reputation.getSummary(id, [...reviewers], tag1, tag2);
    return { agentId: id, reviewers, tag1, tag2, count, average, decimals: Number(decimals), averageText: formatFixed(average, Number(decimals)) };
  }

  /** See `verifySettlement`: checks a settle transaction against the chain alone. */
  verifySettlement(txHash: string, options?: VerifyOptions): Promise<SettlementReport> {
    return verifySettlement(this, txHash, options);
  }
}

export const policyTuple = (p: Policy) => [[...p.reviewers], p.minFeedbackCount, p.minAverageValue, p.decimals, p.tag1] as const;

/** A reader for Monad testnet by default. */
export function createReadClient(options: ReadClientOptions = {}): SealedReader {
  return new SealedReader(options);
}
