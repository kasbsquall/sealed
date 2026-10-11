import type { BaseWallet } from "ethers";
import type { Decision, Reveal } from "../negotiator/negotiator";
import type { Party } from "../relay/party";
import {
  commitTypedData,
  commitmentHash,
  newSalt,
  openNegotiationTypedData,
  settleAuthorizationTypedData,
  type OpenNegotiationMessage,
  type Position,
  type SealedDomain,
  type SettleAuthorizationMessage,
} from "../sealed/commitment";
import { submitCommit } from "./submit";

/** What the desk sells and on what terms. Everything but `floor` is published at GET /v1/desk. */
export interface DeskListing {
  termsSchema: string;
  token: string;
  scale: bigint;
  policyHash: string;
  /** Opening ask, in US cents per 1,000 calls. */
  listPrice: bigint;
  /** The lowest price the desk's seller accepts. Stays on the server, inside salted commitments. */
  floor: bigint;
  /** Kept above the floor in the last round, so the floor itself is never published. */
  finalMargin: bigint;
  maxRounds: number;
}

/** Share of the gap to the floor given up each round, in percent. */
export const CONCESSION_PERCENT = 60n;

/**
 * The ask for a round, from the schedule alone: the list price in round 1, then
 * 60% of the remaining gap to the floor each round, never below floor + margin.
 * A pure function of the round and the listing, never of anything a buyer sent,
 * so a published transcript shows whether the desk's seller kept to it.
 */
export function askFor(listing: DeskListing, round: number): bigint {
  let ask = listing.listPrice;
  for (let r = 2; r <= round; r++) {
    const conceded = ask - ((ask - listing.floor) * CONCESSION_PERCENT) / 100n;
    const lowest = listing.floor + listing.finalMargin;
    ask = conceded < lowest ? lowest : conceded;
  }
  return ask;
}

/**
 * The desk's seller. No model: it follows `askFor`. It signs with its own key
 * and the desk's funded wallet submits its commitments with commitOfferBySig,
 * so only one wallet at the desk ever needs test MON.
 */
export class DeskSeller implements Party {
  private pending?: { round: number; offer: bigint };
  private committed?: Reveal & { commitment: string };

  constructor(
    readonly wallet: BaseWallet,
    private readonly submitter: BaseWallet,
    private readonly domain: SealedDomain,
    private readonly listing: DeskListing,
  ) {}

  async consent(message: OpenNegotiationMessage): Promise<string> {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const l = this.listing;
    if (!same(message.sellerWallet, this.wallet.address)) throw new Error("desk seller: terms name another seller wallet");
    if (message.termsSchema !== l.termsSchema || !same(message.token, l.token) || message.scale !== l.scale || message.policyHash !== l.policyHash) {
      throw new Error("desk seller: terms differ from the desk's listing");
    }
    const typed = openNegotiationTypedData(this.domain, message);
    return this.wallet.signTypedData(typed.domain, { OpenNegotiation: [...typed.types.OpenNegotiation] }, typed.message);
  }

  async decide(round: number): Promise<Decision> {
    const offer = askFor(this.listing, round);
    this.pending = { round, offer };
    const explanation =
      round === 1
        ? `Opened at the list price, ${offer}.`
        : `Moved to ${offer}: ${CONCESSION_PERCENT}% of the remaining gap to its floor, as its published schedule says.`;
    return { round, stance: round === 1 ? "open-with-room" : round === this.listing.maxRounds ? "hold" : "concede", offer, explanation, steps: [] };
  }

  async commit(negotiationId: bigint, commitIndex: number) {
    if (!this.pending) throw new Error("desk seller: commit before decide");
    const position: Position = { offer: this.pending.offer, salt: newSalt() };
    const party = this.wallet.address;
    const commitment = commitmentHash({ domain: this.domain, negotiationId, party, commitIndex, position });
    const typed = commitTypedData(this.domain, { negotiationId, commitment, commitIndex });
    const signature = await this.wallet.signTypedData(typed.domain, { Commit: [...typed.types.Commit] }, typed.message);
    const txHash = await submitCommit(this.submitter, this.domain.verifyingContract, negotiationId, party, commitment, signature);
    this.committed = { party, commitIndex, position, commitment };
    return { txHash, commitment };
  }

  reveal(): Reveal {
    if (!this.committed) throw new Error("desk seller: nothing committed");
    const { commitment: _c, ...reveal } = this.committed;
    return reveal;
  }

  /** Signs only a settlement of its own latest commitment, at that round. */
  async authorize(message: SettleAuthorizationMessage): Promise<string> {
    const c = this.committed;
    if (!c || message.sellerCommitment !== c.commitment || message.sellerCommitIndex !== c.commitIndex) {
      throw new Error("desk seller: authorization names a commitment it did not make");
    }
    const typed = settleAuthorizationTypedData(this.domain, message);
    return this.wallet.signTypedData(typed.domain, { SettleAuthorization: [...typed.types.SettleAuthorization] }, typed.message);
  }
}
