import { Contract, type Provider } from "ethers";

/**
 * What a negotiator may read from the chain while it decides. Everything here
 * is public state: the negotiation as the contract stores it, and the
 * counterparty's reputation in the ERC-8004 Reputation Registry. Nothing
 * private to either agent is on-chain to read.
 */
export interface ChainView {
  negotiation(negotiationId: bigint): Promise<NegotiationState>;
  reputation(agentId: bigint, reviewers: string[]): Promise<ReputationSummary>;
}

export interface NegotiationState {
  status: string;
  buyerAgentId: bigint;
  sellerAgentId: bigint;
  buyerCommitIndex: number;
  sellerCommitIndex: number;
  secondsToDeadline: number;
}

export interface ReputationSummary {
  reviews: number;
  /** Average of the reviews, as a decimal string, e.g. "4.40". */
  average: string;
}

/** Order of `SealedNegotiation.Status`. */
const STATUS = ["None", "Open", "Locked", "Settled", "Expired"];

const SEALED_ABI = [
  "function getNegotiation(uint256 negotiationId) view returns (tuple(address buyerWallet, address sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 buyerCommitIndex, uint32 sellerCommitIndex, uint64 deadline, uint8 status, uint256 settledPrice, bytes32 termsSchema))",
];
const REPUTATION_ABI = [
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
];

export class OnChainView implements ChainView {
  private readonly sealed: Contract;
  private readonly reputationRegistry: Contract;

  constructor(
    private readonly provider: Provider,
    sealedAddress: string,
    reputationAddress: string,
  ) {
    this.sealed = new Contract(sealedAddress, SEALED_ABI, provider);
    this.reputationRegistry = new Contract(reputationAddress, REPUTATION_ABI, provider);
  }

  async negotiation(negotiationId: bigint): Promise<NegotiationState> {
    const [n, block] = await Promise.all([this.sealed.getNegotiation(negotiationId), this.provider.getBlock("latest")]);
    return {
      status: STATUS[Number(n.status)] ?? `Unknown(${n.status})`,
      buyerAgentId: n.buyerAgentId,
      sellerAgentId: n.sellerAgentId,
      buyerCommitIndex: Number(n.buyerCommitIndex),
      sellerCommitIndex: Number(n.sellerCommitIndex),
      secondsToDeadline: Math.max(0, Number(n.deadline) - (block?.timestamp ?? 0)),
    };
  }

  async reputation(agentId: bigint, reviewers: string[]): Promise<ReputationSummary> {
    const [count, value, decimals] = await this.reputationRegistry.getSummary(agentId, reviewers, "", "");
    return { reviews: Number(count), average: fixed(BigInt(value), Number(decimals)) };
  }
}

/** 440 with 2 decimals is "4.40": keeps the registry's precision, trailing zeros included. */
function fixed(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0");
  return decimals === 0 ? sign + digits : `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
