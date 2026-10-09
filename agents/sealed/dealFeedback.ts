import { Contract, Interface, type Provider } from "ethers";

/**
 * ERC-8004 feedback that costs a real deal.
 *
 * After a settlement, each agent rates the other in the canonical Reputation
 * Registry, and the feedback's `feedbackHash` is the settlement transaction. A
 * reader can follow that hash to a `NegotiationSettled` event on Sealed whose
 * two parties are exactly the reviewer and the agent reviewed, so a review of
 * this kind cannot be written without closing a deal through Sealed first.
 *
 * The rating records a fact, not an opinion: the counterparty settled what it
 * committed to. The agent checks that fact on-chain itself before rating, so a
 * relay cannot make it rate an agent it never traded with.
 */

export const DEAL_FEEDBACK = { value: 100n, valueDecimals: 0, tag1: "sealed", tag2: "settled" } as const;

export interface DealFeedback {
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}

export interface SettledNegotiation {
  negotiationId: bigint;
  buyerWallet: string;
  sellerWallet: string;
  buyerAgentId: bigint;
  sellerAgentId: bigint;
}

/** Order of `SealedNegotiation.Status`. */
const SETTLED = 3n;

const sealedInterface = new Interface([
  "event NegotiationSettled(uint256 indexed negotiationId, uint256 price)",
  "function getNegotiation(uint256 negotiationId) view returns (tuple(address buyerWallet, address sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 buyerCommitIndex, uint32 sellerCommitIndex, uint64 deadline, uint8 status, uint256 settledPrice, bytes32 termsSchema))",
]);

export const reputationInterface = new Interface([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

/** The feedback `reviewer` gives its counterparty for one settled negotiation. Pure. */
export function feedbackFor(deal: SettledNegotiation, reviewer: string, settleTx: string, chainId: bigint | number): DealFeedback {
  const who = reviewer.toLowerCase();
  const agentId =
    who === deal.buyerWallet.toLowerCase() ? deal.sellerAgentId : who === deal.sellerWallet.toLowerCase() ? deal.buyerAgentId : undefined;
  if (agentId === undefined) throw new Error(`${reviewer} is not a party to negotiation ${deal.negotiationId}`);
  return {
    agentId,
    ...DEAL_FEEDBACK,
    endpoint: "",
    feedbackURI: `eip155:${chainId}:tx:${settleTx}`,
    feedbackHash: settleTx,
  };
}

/**
 * Reads `settleTx` from the chain and returns the negotiation it settled. Throws
 * unless it is a successful transaction to `sealedAddress` that emitted
 * `NegotiationSettled`, and the contract still reports that negotiation settled.
 */
export async function readSettlement(provider: Provider, sealedAddress: string, settleTx: string): Promise<SettledNegotiation> {
  const receipt = await provider.getTransactionReceipt(settleTx);
  if (!receipt || receipt.status !== 1) throw new Error(`${settleTx} is not a successful transaction`);
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === sealedAddress.toLowerCase() && l.topics[0] === sealedInterface.getEvent("NegotiationSettled")!.topicHash,
  );
  if (!log) throw new Error(`${settleTx} did not settle a negotiation on ${sealedAddress}`);
  const negotiationId: bigint = sealedInterface.parseLog(log)!.args.negotiationId;
  const n = await new Contract(sealedAddress, sealedInterface, provider).getNegotiation(negotiationId);
  if (n.status !== SETTLED) throw new Error(`negotiation ${negotiationId} is not settled`);
  return {
    negotiationId,
    buyerWallet: n.buyerWallet,
    sellerWallet: n.sellerWallet,
    buyerAgentId: n.buyerAgentId,
    sellerAgentId: n.sellerAgentId,
  };
}

/** Arguments for `giveFeedback`, in order. */
export const giveFeedbackArgs = (f: DealFeedback) =>
  [f.agentId, f.value, f.valueDecimals, f.tag1, f.tag2, f.endpoint, f.feedbackURI, f.feedbackHash] as const;
