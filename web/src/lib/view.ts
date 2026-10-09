import type { Run } from "./data";
import { dollars, short, terms, txUrl, utc } from "./format";

/**
 * The view model of the featured negotiation order: every string the
 * triplicate set and the order log type out, derived from the committed
 * transcripts. Plain data, so it can cross into the client components.
 */

export interface TxRef {
  label: string;
  href: string;
}

export interface SealedSide {
  price: string;
  /** The commitment hash the chain stored for this offer, shortened, linking to its commit transaction. */
  hash: TxRef;
}

export interface OrderRound {
  n: number;
  slot: string;
  meet: boolean;
  buyer: SealedSide;
  seller: SealedSide;
}

export interface Step {
  n: number;
  slot: string;
  /** One line: what happened at this step. */
  title: string;
  links: TxRef[];
}

export interface OrderView {
  id: string;
  terms: string;
  reference: string;
  deadline: string;
  buyerId: string;
  sellerId: string;
  admitted: { buyer: boolean; seller: boolean };
  rounds: OrderRound[];
  settle: { line: string; price: string; tx: TxRef };
  steps: Step[];
}

/** The referee's one bit, in words. */
export const meetLabel = (meet: boolean) => (meet ? "Offers meet" : "Offers apart");

const sealed = (price: string, commitment: string, commitTx: string): SealedSide => ({
  price: dollars(price),
  hash: { label: short(commitment), href: txUrl(commitTx) },
});

export function orderView(deal: Run, admitted: OrderView["admitted"]): OrderView {
  const last = deal.rounds[deal.rounds.length - 1];

  const rounds: OrderRound[] = deal.rounds.map((r) => ({
    n: r.round,
    slot: `r${r.round}`,
    meet: r.crossed,
    buyer: sealed(r.buyer.offer, r.buyer.commitment, r.buyer.commitTx),
    seller: sealed(r.seller.offer, r.seller.commitment, r.seller.commitTx),
  }));

  const steps: Omit<Step, "n">[] = [
    {
      slot: "adm",
      title: `Agents #${deal.agents.buyer.agentId} and #${deal.agents.seller.agentId} admitted, negotiation #${deal.negotiationId} opened`,
      links: [{ label: `Open ${short(deal.createTx)}`, href: txUrl(deal.createTx) }],
    },
    ...deal.rounds.map((r) => ({
      slot: `r${r.round}`,
      title: `Round ${r.round}: both offers sealed, ${meetLabel(r.crossed).toLowerCase()}`,
      links: [
        { label: `Buyer ${short(r.buyer.commitTx)}`, href: txUrl(r.buyer.commitTx) },
        { label: `Seller ${short(r.seller.commitTx)}`, href: txUrl(r.seller.commitTx) },
      ],
    })),
    {
      slot: "set",
      title: `Settled at ${dollars(deal.settledPrice!)} per 1,000 calls; ${dollars(last.buyer.offer)} and ${dollars(last.seller.offer)} opened`,
      links: [{ label: `Settle ${short(deal.settleTx!)}`, href: txUrl(deal.settleTx!) }],
    },
  ];

  return {
    id: deal.negotiationId,
    terms: terms(deal.terms),
    reference: `${dollars(deal.referencePrice)} per 1,000 calls`,
    deadline: utc(deal.deadline),
    buyerId: deal.agents.buyer.agentId,
    sellerId: deal.agents.seller.agentId,
    admitted,
    rounds,
    settle: {
      line: `Buyer's limit ${dollars(deal.agents.buyer.limit)}, paid ${dollars(deal.settledPrice!)}. The seller never saw ${dollars(deal.agents.buyer.limit)}.`,
      price: dollars(deal.settledPrice!),
      tx: { label: short(deal.settleTx!), href: txUrl(deal.settleTx!) },
    },
    steps: steps.map((s, i) => ({ ...s, n: i + 1 })),
  };
}
