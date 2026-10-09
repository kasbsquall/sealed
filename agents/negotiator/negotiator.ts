import { commitmentHash, newSalt, type Position, type SealedDomain, type SettleAuthorizationMessage } from "../sealed/commitment";
import type { LlmClient } from "../llm/client";
import type { PartyWallet } from "../wallets/partyWallet";

export type Role = "buyer" | "seller";

/**
 * What the principal authorizes. Private to the agent: it goes to the agent's
 * own model and nowhere else, never to the relay, the counterparty or the chain.
 */
export interface Mandate {
  role: Role;
  /** Buyer: the most it may pay. Seller: the least it may accept. Hard limit. */
  limit: bigint;
  /** Public reference price both sides can see, e.g. a recent market quote. */
  reference: bigint;
  maxRounds: number;
  unit: string;
}

/** The move the model chose for a round. The number is chosen alongside it. */
export const STANCES = ["open-with-room", "concede", "hold", "final-at-limit"] as const;
export type Stance = (typeof STANCES)[number];

export interface Decision {
  round: number;
  /** Chosen by the model. */
  stance: Stance;
  offer: bigint;
  /** What the model proposed, when the code had to correct it. */
  proposedOffer?: bigint;
  correction?: "limit" | "no-backtracking";
  /**
   * Written by code from the committed numbers, never by the model. A small
   * local model picks good numbers but misstates arithmetic when it explains
   * them, so the explanation is derived rather than generated.
   */
  explanation: string;
}

/** What the agent hands the relay after committing: enough to check it against the chain. */
export interface Reveal {
  party: string;
  commitIndex: number;
  position: Position;
}

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stance", "offer"],
  properties: {
    stance: { type: "string", enum: [...STANCES] },
    offer: { type: "integer", description: "This round's sealed number, in the unit given." },
  },
};

/**
 * A negotiator. The model proposes; the code disposes. Whatever the model says,
 * the agent never commits past its principal's limit and never walks back an
 * earlier concession, and every correction is recorded.
 */
export class NegotiatorAgent {
  readonly decisions: Decision[] = [];
  private current?: { negotiationId: bigint; commitIndex: number; position: Position; commitment: string };

  constructor(
    readonly name: string,
    private readonly mandate: Mandate,
    readonly wallet: PartyWallet,
    private readonly llm: LlmClient,
    private readonly domain: SealedDomain,
  ) {}

  get role() {
    return this.mandate.role;
  }

  async decide(round: number): Promise<Decision> {
    const proposed = await this.askModel(round);
    const decision = this.enforceMandate(round, proposed);
    this.decisions.push(decision);
    return decision;
  }

  /** Commits the latest decision. The offer and salt stay here; only a hash leaves. */
  async commit(negotiationId: bigint, commitIndex: number): Promise<{ txHash: string; commitment: string }> {
    const decision = this.decisions.at(-1);
    if (!decision) throw new Error(`${this.name} has no decision to commit`);
    const position: Position = { offer: decision.offer, salt: newSalt() };
    const commitment = commitmentHash({ domain: this.domain, negotiationId, party: this.wallet.address, commitIndex, position });
    const txHash = await this.wallet.commit(negotiationId, commitIndex, position);
    this.current = { negotiationId, commitIndex, position, commitment };
    return { txHash, commitment };
  }

  /** Given only to the clearing relay, which checks it against the on-chain commitment. */
  reveal(): Reveal {
    if (!this.current) throw new Error(`${this.name} has nothing committed`);
    return { party: this.wallet.address, commitIndex: this.current.commitIndex, position: this.current.position };
  }

  /**
   * Signs only an authorization over its own latest commitment. Safe without
   * knowing the counterparty's number: the contract settles at the midpoint of
   * two numbers that cross, so a buyer never pays above its own number and a
   * seller never receives below its own.
   */
  async authorize(message: SettleAuthorizationMessage): Promise<string> {
    if (!this.current || message.negotiationId !== this.current.negotiationId) {
      throw new Error(`${this.name}: authorization for an unknown negotiation`);
    }
    const [commitment, index] =
      this.role === "buyer"
        ? [message.buyerCommitment, message.buyerCommitIndex]
        : [message.sellerCommitment, message.sellerCommitIndex];
    if (commitment !== this.current.commitment || index !== this.current.commitIndex) {
      throw new Error(`${this.name}: authorization does not match its own latest commitment`);
    }
    return this.wallet.authorizeSettlement(message);
  }

  private async askModel(round: number): Promise<{ offer: bigint; stance: Stance }> {
    const { role, limit, reference, maxRounds, unit } = this.mandate;
    const counterparty = role === "buyer" ? "seller" : "buyer";
    const [limitRule, toward, away] =
      role === "buyer"
        ? [`Never commit a number above ${limit}.`, "up", "down"]
        : [`Never commit a number below ${limit}.`, "down", "up"];
    const previous = this.decisions.map((d) => String(d.offer));
    const last = round === maxRounds;

    const messages = [
      {
        role: "system" as const,
        content: [
          `You negotiate a price for a ${role}. Every price is an integer in ${unit}, on the same scale as the reference price (for example ${reference + 100n}).`,
          `Your principal's hard limit is ${limit}. ${limitRule} Software enforces this too.`,
          `Each round, you and the ${counterparty} each commit one sealed number at the same time. A clearing relay only says whether the numbers crossed (buyer's number at or above seller's number). If they cross, the deal settles at the midpoint of the two numbers. You never learn the ${counterparty}'s number.`,
          `There are at most ${maxRounds} rounds. If nothing crosses by the last round, there is no deal, and a deal inside your limit is better for your principal than no deal.`,
          `So: open with room to move, never move ${away} from an earlier number, move ${toward} toward your limit each round that does not cross, and in the last round commit at or very near your limit.`,
          `Pick a stance (${STANCES.join(", ")}) and the number that carries it out. Reply only with the JSON object.`,
        ].join(" "),
      },
      {
        role: "user" as const,
        content: [
          `Round ${round} of ${maxRounds}${last ? " (last round)" : ""}.`,
          `Public reference price: ${reference}.`,
          previous.length ? `Your earlier numbers: ${previous.join(", ")}. None crossed.` : `Opening round.`,
          `Your stance and number for this round?`,
        ].join(" "),
      },
    ];

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await this.llm.chatJson<{ offer: number; stance: string }>(messages, "decision", DECISION_SCHEMA);
        // A small model sometimes answers on the wrong scale (4e15 for 4000). Anything
        // more than 10x away from the public reference is treated as no answer.
        const plausible = out.offer * 10 >= Number(reference) && out.offer <= Number(reference) * 10;
        if (!Number.isInteger(out.offer) || out.offer <= 0 || !plausible) throw new Error(`implausible offer ${out.offer}`);
        if (!STANCES.includes(out.stance as Stance)) throw new Error(`unknown stance ${out.stance}`);
        return { offer: BigInt(out.offer), stance: out.stance as Stance };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`${this.name}: model gave no usable decision (${String(lastError)})`);
  }

  private enforceMandate(round: number, proposed: { offer: bigint; stance: Stance }): Decision {
    const { role, limit } = this.mandate;
    const previous = this.decisions.at(-1)?.offer;
    let offer = proposed.offer;
    let correction: Decision["correction"];

    if (role === "buyer" && offer > limit) [offer, correction] = [limit, "limit"];
    if (role === "seller" && offer < limit) [offer, correction] = [limit, "limit"];
    if (previous !== undefined && correction === undefined) {
      if (role === "buyer" && offer < previous) [offer, correction] = [previous, "no-backtracking"];
      if (role === "seller" && offer > previous) [offer, correction] = [previous, "no-backtracking"];
    }

    const explanation = this.explain(offer, previous, proposed.offer, correction);
    return correction
      ? { round, stance: proposed.stance, offer, proposedOffer: proposed.offer, correction, explanation }
      : { round, stance: proposed.stance, offer, explanation };
  }

  /** Plain-English account of a committed number, computed from the numbers themselves. */
  private explain(offer: bigint, previous: bigint | undefined, proposed: bigint, correction?: Decision["correction"]) {
    const { role, limit, reference } = this.mandate;
    const gap = (a: bigint, b: bigint, above: string, below: string) =>
      a === b ? `equal to ${below === "below its limit" ? "its limit" : "the reference"}` : a > b ? `${a - b} ${above}` : `${b - a} ${below}`;
    const vsRef = gap(offer, reference, "above the reference", "below the reference");
    const room = offer === limit ? "at its limit" : gap(offer, limit, "above its limit", "below its limit");

    let move: string;
    if (previous === undefined) move = `Opened at ${offer}`;
    else if (offer === previous) move = `Held at ${offer}`;
    else move = `Moved ${offer > previous ? "up" : "down"} ${offer > previous ? offer - previous : previous - offer} to ${offer}`;

    const parts = [`${move}, ${vsRef}, ${room}.`];
    if (correction === "limit") {
      parts.push(`The model asked for ${proposed}; code held the ${role} to its limit of ${limit}.`);
    } else if (correction === "no-backtracking") {
      parts.push(`The model asked for ${proposed}, which would take back an earlier concession; code kept ${offer}.`);
    }
    return parts.join(" ");
  }
}
