import { commitmentHash, newSalt, type Position, type SealedDomain, type SettleAuthorizationMessage } from "../sealed/commitment";
import type { ChatMessage, LlmClient, ToolCall } from "../llm/client";
import type { PartyWallet } from "../wallets/partyWallet";
import type { ChainView } from "./chainView";
import { NEGOTIATOR_TOOLS, STANCES, type Stance } from "./tools";

export { STANCES, type Stance };
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
  /** The model's own note for this round, verbatim. Carried into later rounds. */
  note?: string;
  /** Every tool the model called this round, in order, with what it got back. */
  steps: AgentStep[];
}

export interface AgentStep {
  tool: string;
  input: Record<string, unknown>;
  output: string;
}

/** Public, read-only chain access for the read tools. Without it they say so. */
export interface AgentOptions {
  chain?: ChainView;
  /** Reviewers whose ERC-8004 feedback this agent's principal trusts. */
  reviewers?: string[];
  /** Wall-clock time a round may take before the model must submit. */
  roundBudgetMs?: number;
}

/** What the agent hands the relay after committing: enough to check it against the chain. */
export interface Reveal {
  party: string;
  commitIndex: number;
  position: Position;
}

/**
 * Per round: model turns (the last two may only submit), tool calls handled per
 * reply, rejected submissions before code steps in, model errors before failing
 * closed, and the default time budget. Rounds have to fit the on-chain deadline.
 */
const MAX_TURNS = 6;
const FORCED_SUBMIT_TURNS = 2;
const MAX_CALLS_PER_REPLY = 4;
const MAX_REJECTIONS = 2;
const MAX_MODEL_ERRORS = 3;
const ROUND_BUDGET_MS = 45_000;
const MAX_NOTE_LENGTH = 500;
const SUBMIT_ONLY = NEGOTIATOR_TOOLS.filter((t) => t.name === "submit_offer");

type Proposal = { offer: bigint; stance: Stance; note?: string };
type Check = { allowed: true } | { allowed: false; reason: string; plausible: boolean };
type Submission = { decision: Omit<Decision, "steps"> } | { reason: string; proposal?: Proposal; implausible?: string };

/**
 * A negotiator. The model proposes; the code disposes. The model works each
 * round in steps, reading the negotiation and the counterparty's on-chain
 * reputation and checking candidate numbers through tools, then submits one
 * number. Whatever it submits, the agent never commits past its principal's
 * limit and never walks back an earlier concession, and every rejection and
 * correction is recorded.
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
    private readonly options: AgentOptions = {},
  ) {}

  get role() {
    return this.mandate.role;
  }

  /**
   * One round, worked in steps. Code checks every submission against the
   * mandate and hands a rejection back to the model with the reason. After
   * repeated rejections code takes the last proposal and clamps it.
   */
  async decide(round: number, negotiationId?: bigint): Promise<Decision> {
    const steps: AgentStep[] = [];
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt() },
      { role: "user", content: this.roundBrief(round) },
    ];
    const proposals: Proposal[] = [];
    let implausible: string | undefined;
    let errors = 0;
    let rejections = 0;
    const startedAt = Date.now();
    const budget = this.options.roundBudgetMs ?? ROUND_BUDGET_MS;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Reading is optional; submitting is not. Near the end of the turn or time
      // budget, the model is offered submit_offer alone and must call it.
      const mustSubmit = turn >= MAX_TURNS - FORCED_SUBMIT_TURNS || Date.now() - startedAt > budget;
      let reply;
      try {
        reply = mustSubmit
          ? await this.llm.chat(messages, SUBMIT_ONLY, "submit_offer")
          : await this.llm.chat(messages, NEGOTIATOR_TOOLS);
      } catch (error) {
        if (++errors >= MAX_MODEL_ERRORS) throw new Error(`${this.name}: model gave no usable decision (${String(error)})`);
        continue;
      }
      if (!reply.toolCalls.length) {
        messages.push({ role: "assistant", content: reply.content });
        messages.push({ role: "user", content: "Use the tools. End this round by calling submit_offer." });
        continue;
      }
      messages.push({ role: "assistant", content: reply.content, toolCalls: reply.toolCalls });

      for (const [index, call] of reply.toolCalls.entries()) {
        const input = clip(parseArguments(call));
        if (call.name !== "submit_offer") {
          // Every tool call gets an answer, or the next request is malformed.
          const output =
            index >= MAX_CALLS_PER_REPLY
              ? "skipped: too many tool calls in one reply"
              : mustSubmit
                ? "not available now: call submit_offer"
                : await this.runReadTool(call.name, input, round, negotiationId);
          steps.push({ tool: call.name, input, output });
          messages.push({ role: "tool", toolCallId: call.id, content: output });
          continue;
        }

        const submission = this.readSubmission(input, round);
        if ("decision" in submission) {
          steps.push({ tool: call.name, input, output: "accepted" });
          return this.record({ ...submission.decision, steps });
        }
        const output = `rejected: ${submission.reason}`;
        steps.push({ tool: call.name, input, output });
        messages.push({ role: "tool", toolCallId: call.id, content: output });
        if (submission.proposal) proposals.push(submission.proposal);
        // The model's latest answer decides: after a wrong-scale number, code does
        // not fall back to an older proposal.
        implausible = submission.implausible;
        if (++rejections >= MAX_REJECTIONS) return this.codeDisposes(round, proposals, implausible, steps);
      }
    }
    return this.codeDisposes(round, proposals, implausible, steps);
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

  private record(decision: Decision): Decision {
    this.decisions.push(decision);
    return decision;
  }

  /**
   * The model never got a number through. Code clamps its last proposal, or
   * fails closed when there is none or the model's latest answer was off scale.
   */
  private codeDisposes(round: number, proposals: Proposal[], implausible: string | undefined, steps: AgentStep[]): Decision {
    const last = proposals.at(-1);
    if (!last || implausible) throw new Error(`${this.name}: model gave no usable decision (${implausible ?? "no offer submitted"})`);
    const { role, limit } = this.mandate;
    const previous = this.decisions.at(-1)?.offer;
    let offer = last.offer;
    let correction: Decision["correction"];

    if (role === "buyer" && offer > limit) [offer, correction] = [limit, "limit"];
    if (role === "seller" && offer < limit) [offer, correction] = [limit, "limit"];
    if (previous !== undefined && correction === undefined) {
      if (role === "buyer" && offer < previous) [offer, correction] = [previous, "no-backtracking"];
      if (role === "seller" && offer > previous) [offer, correction] = [previous, "no-backtracking"];
    }

    return this.record({
      round,
      stance: last.stance,
      offer,
      ...(correction ? { proposedOffer: last.offer, correction } : {}),
      explanation: this.explain(offer, previous, last.offer, correction),
      ...(last.note ? { note: last.note } : {}),
      steps,
    });
  }

  /** The rules submit_offer enforces, also used by check_offer without committing. */
  private check(offer: bigint): Check {
    const { role, limit, reference } = this.mandate;
    // A small model sometimes answers on the wrong scale (4e15 for 4000). Anything
    // more than 10x away from the public reference is treated as no answer.
    if (offer * 10n < reference || offer > reference * 10n) {
      return { allowed: false, plausible: false, reason: `implausible offer ${offer}, off the scale of the reference price ${reference}` };
    }
    if (role === "buyer" && offer > limit) return { allowed: false, plausible: true, reason: `above your limit of ${limit}` };
    if (role === "seller" && offer < limit) return { allowed: false, plausible: true, reason: `below your limit of ${limit}` };
    const previous = this.decisions.at(-1)?.offer;
    if (previous !== undefined && ((role === "buyer" && offer < previous) || (role === "seller" && offer > previous))) {
      return { allowed: false, plausible: true, reason: `would take back your earlier offer of ${previous}` };
    }
    return { allowed: true };
  }

  private readSubmission(input: Record<string, unknown>, round: number): Submission {
    const stance = input.stance as Stance;
    if (!STANCES.includes(stance)) return { reason: `stance must be one of ${STANCES.join(", ")}` };
    const offer = toInteger(input.offer);
    if (offer === undefined) {
      if (typeof input.offer === "number" && input.offer > Number.MAX_SAFE_INTEGER) {
        return { reason: `implausible offer ${input.offer}`, implausible: `implausible offer ${input.offer}` };
      }
      return { reason: "offer must be a positive integer" };
    }
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, MAX_NOTE_LENGTH) : undefined;

    const check = this.check(offer);
    if (!check.allowed) {
      return check.plausible ? { reason: check.reason, proposal: { offer, stance, note } } : { reason: check.reason, implausible: check.reason };
    }
    const previous = this.decisions.at(-1)?.offer;
    return { decision: { round, stance, offer, explanation: this.explain(offer, previous, offer), ...(note ? { note } : {}) } };
  }

  private async runReadTool(name: string, input: Record<string, unknown>, round: number, negotiationId?: bigint): Promise<string> {
    try {
      switch (name) {
        case "read_negotiation":
          return JSON.stringify(await this.readNegotiation(round, negotiationId));
        case "read_counterparty_reputation":
          return JSON.stringify(await this.readCounterpartyReputation(negotiationId));
        case "check_offer": {
          const offer = toInteger(input.offer);
          return JSON.stringify(offer === undefined ? { allowed: false, reason: "offer must be a positive integer" } : this.describeOffer(offer));
        }
        default:
          return JSON.stringify({ error: `unknown tool ${name}` });
      }
    } catch (error) {
      // ethers puts the request, RPC URL included, in `message`; keep it out of the model's context.
      return JSON.stringify({ error: (error as { shortMessage?: string }).shortMessage ?? "chain read failed" });
    }
  }

  private async readNegotiation(round: number, negotiationId?: bigint) {
    const { maxRounds } = this.mandate;
    const { chain } = this.options;
    const onChain = chain && negotiationId !== undefined ? await chain.negotiation(negotiationId) : undefined;
    return {
      round,
      maxRounds,
      roundsLeft: maxRounds - round,
      ...(onChain ? { status: onChain.status, secondsToDeadline: onChain.secondsToDeadline } : { chain: "not available" }),
      // A negotiation only reaches another round when the earlier ones did not cross.
      yourEarlierRounds: this.decisions.map((d) => ({ round: d.round, offer: d.offer.toString(), crossed: false, ...(d.note ? { note: d.note } : {}) })),
    };
  }

  private async readCounterpartyReputation(negotiationId?: bigint) {
    const { chain, reviewers } = this.options;
    if (!chain || negotiationId === undefined || !reviewers?.length) return { error: "reputation not available to this agent" };
    const n = await chain.negotiation(negotiationId);
    const agentId = this.role === "buyer" ? n.sellerAgentId : n.buyerAgentId;
    const summary = await chain.reputation(agentId, reviewers);
    return { counterparty: this.role === "buyer" ? "seller" : "buyer", agentId: agentId.toString(), ...summary, trustedReviewers: reviewers.length };
  }

  private describeOffer(offer: bigint) {
    const { role, limit, reference } = this.mandate;
    const check = this.check(offer);
    return {
      offer: offer.toString(),
      ...(check.allowed ? { allowed: true } : { allowed: false, reason: check.reason }),
      versusReference: offer > reference ? `+${offer - reference}` : (offer - reference).toString(),
      roomLeftToLimit: (role === "buyer" ? limit - offer : offer - limit).toString(),
      ifItCrosses: role === "buyer" ? `you pay the midpoint, at most ${offer}` : `you receive the midpoint, at least ${offer}`,
    };
  }

  private systemPrompt() {
    const { role, limit, reference, maxRounds, unit } = this.mandate;
    const counterparty = role === "buyer" ? "seller" : "buyer";
    const [limitRule, toward, away] =
      role === "buyer"
        ? [`Never commit a number above ${limit}.`, "up", "down"]
        : [`Never commit a number below ${limit}.`, "down", "up"];
    return [
      `You negotiate a price for a ${role}. Every price is an integer in ${unit}, on the same scale as the reference price (for example ${reference + 100n}).`,
      `Your principal's hard limit is ${limit}. ${limitRule} Software checks every number you submit and rejects any that breaks the rules.`,
      `Each round, you and the ${counterparty} each commit one sealed number at the same time. A clearing relay only says whether the numbers crossed (buyer's number at or above seller's number). If they cross, the deal settles at the midpoint of the two numbers. You never learn the ${counterparty}'s number.`,
      `There are at most ${maxRounds} rounds. If nothing crosses by the last round, there is no deal, and a deal inside your limit is better for your principal than no deal.`,
      `Never move ${away} from an earlier number; move ${toward} toward your limit in rounds that do not cross, and in the last round commit at or very near your limit.`,
      `Work in steps with the tools. read_negotiation gives the round, the time left on-chain and your own earlier offers and notes. read_counterparty_reputation reads the ${counterparty}'s ERC-8004 reputation on-chain. check_offer tells you whether a number is allowed and what it means for your principal. When you have decided, call submit_offer once with a stance, the number and a short note.`,
      `In round 1, use the note to lay out your plan for all ${maxRounds} rounds. In later rounds, read your earlier notes and say whether you are following the plan or changing it, and why.`,
    ].join(" ");
  }

  private roundBrief(round: number) {
    const { maxRounds, reference } = this.mandate;
    const last = round === maxRounds ? " This is the last round." : "";
    return `Round ${round} of ${maxRounds}.${last} Public reference price: ${reference}. Decide this round's number and submit it.`;
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

function parseArguments(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Tool inputs go into the transcript; long strings are cut like the note. */
function clip(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, typeof v === "string" && v.length > MAX_NOTE_LENGTH ? `${v.slice(0, MAX_NOTE_LENGTH)}...` : v]),
  );
}

/** Accepts an integer number or an integer string, like 4200 or "4200". */
function toInteger(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}
