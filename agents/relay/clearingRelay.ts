import { Contract, type BaseWallet } from "ethers";
import { commitmentHash, type SealedDomain } from "../sealed/commitment";
import { chainFees } from "../sealed/fees";
import type { Decision, Reveal } from "../negotiator/negotiator";
import type { Party } from "./party";

/**
 * The clearing relay runs the rounds of a negotiation between two agents.
 *
 * Each round both agents commit a hash on-chain, then hand the relay their
 * reveal. The relay checks each reveal against the commitment on-chain (so an
 * agent cannot tell it one number and commit another) and answers one bit:
 * crossed or not. If the numbers cross, both agents authorize that exact pair
 * and the relay submits the atomic settlement. If they never cross, the relay
 * lets the deadline pass and expires the negotiation.
 *
 * Trust model, stated plainly: the relay cannot change or forge a deal, because
 * settlement needs both agents' signatures over the exact committed pair and the
 * contract checks every reveal against its hash. It is trusted with
 * confidentiality: it sees both numbers of a round that does not cross, and
 * discards them. Neither agent ever learns the other's number unless the deal
 * settles. In production the relay belongs in an attested TEE.
 */

const SEALED_ABI = [
  "function createNegotiation(uint256 buyerAgentId, address buyerWallet, uint256 sellerAgentId, address sellerWallet, uint64 deadline, bytes32 termsSchema, (address[] reviewers, uint64 minFeedbackCount, int128 minAverageValue, uint8 decimals, string tag1) policy) returns (uint256)",
  "function settle(uint256 negotiationId, (uint256 offer, bytes32 salt) buyerReveal, (uint256 offer, bytes32 salt) sellerReveal, bytes buyerAuthorization, bytes sellerAuthorization) returns (uint256)",
  "function expire(uint256 negotiationId)",
  "function getNegotiation(uint256 negotiationId) view returns ((address buyerWallet, address sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 buyerCommitIndex, uint32 sellerCommitIndex, uint64 deadline, uint8 status, uint256 settledPrice, bytes32 termsSchema))",
  "event NegotiationCreated(uint256 indexed negotiationId, address indexed buyerWallet, address indexed sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, uint64 deadline, bytes32 termsSchema)",
];

export interface Policy {
  reviewers: string[];
  minFeedbackCount: number | bigint;
  minAverageValue: number | bigint;
  decimals: number;
  tag1: string;
}

export interface PartyRound {
  offer: string;
  proposedOffer?: string;
  correction?: Decision["correction"];
  stance: Decision["stance"];
  explanation: string;
  /** The model's own note for the round, verbatim. */
  note?: string;
  /** The tools the model called before committing, with what each returned. */
  steps?: Decision["steps"];
  commitIndex: number;
  commitment: string;
  commitTx: string;
  /** Published by the demo so anyone can recompute the hash. A real agent never discloses it. */
  salt: string;
}

export interface RoundRecord {
  round: number;
  buyer: PartyRound;
  seller: PartyRound;
  crossed: boolean;
}

export interface NegotiationRecord {
  negotiationId: string;
  createTx: string;
  deadline: string;
  rounds: RoundRecord[];
  outcome: "settled" | "expired" | "aborted";
  settleTx?: string;
  expireTx?: string;
  settledPrice?: string;
  abortReason?: string;
}

export interface NegotiationRequest {
  buyer: { agent: Party; agentId: bigint };
  seller: { agent: Party; agentId: bigint };
  termsSchema: string;
  policy: Policy;
  maxRounds: number;
  /** Seconds from now. The contract requires more than 60. */
  windowSeconds: number;
  onEvent?: (message: string) => void;
}

export class ClearingRelay {
  private readonly sealed: Contract;

  constructor(
    private readonly relayer: BaseWallet,
    private readonly domain: SealedDomain,
    /** How to wait for the deadline. Tests swap this for a local time jump. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.sealed = new Contract(domain.verifyingContract, SEALED_ABI, relayer);
  }

  async negotiate(request: NegotiationRequest): Promise<NegotiationRecord> {
    const log = request.onEvent ?? (() => {});
    const provider = this.relayer.provider!;
    const now = BigInt((await provider.getBlock("latest"))!.timestamp);
    const deadline = now + BigInt(request.windowSeconds);

    const createTx = await this.sealed.createNegotiation(
      request.buyer.agentId,
      request.buyer.agent.wallet.address,
      request.seller.agentId,
      request.seller.agent.wallet.address,
      deadline,
      request.termsSchema,
      request.policy,
      await chainFees(provider),
    );
    const receipt = await createTx.wait();
    const created = receipt.logs
      .map((l: any) => {
        try {
          return this.sealed.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p?.name === "NegotiationCreated");
    const negotiationId: bigint = created.args.negotiationId;
    log(`negotiation ${negotiationId} opened, deadline ${deadline}`);

    const record: NegotiationRecord = {
      negotiationId: negotiationId.toString(),
      createTx: createTx.hash,
      deadline: deadline.toString(),
      rounds: [],
      outcome: "expired",
    };

    for (let round = 1; round <= request.maxRounds; round++) {
      let result: Awaited<ReturnType<ClearingRelay["playRound"]>>;
      try {
        result = await this.playRound(negotiationId, round, request);
      } catch (error) {
        // Fail closed: an agent that cannot decide or commit ends the negotiation
        // without a deal. Nothing already committed is ever revealed.
        record.outcome = "aborted";
        record.abortReason = String(error instanceof Error ? error.message : error);
        log(`round ${round} aborted: ${record.abortReason}`);
        break;
      }
      record.rounds.push(result.round);
      log(`round ${round}: ${result.round.crossed ? "crossed" : "did not cross"}`);

      if (result.round.crossed) {
        const settled = await this.settle(negotiationId, request, result.reveals, result.onChain);
        Object.assign(record, { outcome: "settled", ...settled });
        log(`settled at ${settled.settledPrice}`);
        return record;
      }
    }

    record.expireTx = await this.expireAfterDeadline(negotiationId, deadline, log);
    if (record.outcome !== "aborted") record.outcome = "expired";
    return record;
  }

  private async playRound(negotiationId: bigint, round: number, request: NegotiationRequest) {
    // Every commit goes through this relay, one per party per round, so the
    // expected index is the round number. Reading it back from a lagging RPC node
    // could give a stale value; a party committing behind the relay's back is
    // caught by the reveal check below.
    const buyerIndex = round;
    const sellerIndex = round;

    // Both agents decide independently and commit in parallel. Neither sees the other.
    const [buyerDecision, sellerDecision] = await Promise.all([
      request.buyer.agent.decide(round, negotiationId),
      request.seller.agent.decide(round, negotiationId),
    ]);
    const [buyerCommit, sellerCommit] = await Promise.all([
      request.buyer.agent.commit(negotiationId, buyerIndex),
      request.seller.agent.commit(negotiationId, sellerIndex),
    ]);

    const reveals = { buyer: await request.buyer.agent.reveal(), seller: await request.seller.agent.reveal() };
    const onChain = await this.waitForCommitIndices(negotiationId, buyerIndex, sellerIndex);
    this.checkReveal(negotiationId, reveals.buyer, onChain.buyerCommitment, Number(onChain.buyerCommitIndex));
    this.checkReveal(negotiationId, reveals.seller, onChain.sellerCommitment, Number(onChain.sellerCommitIndex));

    const party = (d: Decision, c: { txHash: string; commitment: string }, r: Reveal): PartyRound => ({
      offer: d.offer.toString(),
      ...(d.proposedOffer !== undefined ? { proposedOffer: d.proposedOffer.toString(), correction: d.correction } : {}),
      stance: d.stance,
      explanation: d.explanation,
      ...(d.note ? { note: d.note } : {}),
      steps: d.steps,
      commitIndex: r.commitIndex,
      commitment: c.commitment,
      commitTx: c.txHash,
      salt: r.position.salt,
    });

    return {
      round: {
        round,
        buyer: party(buyerDecision, buyerCommit, reveals.buyer),
        seller: party(sellerDecision, sellerCommit, reveals.seller),
        crossed: reveals.buyer.position.offer >= reveals.seller.position.offer,
      },
      reveals,
      onChain,
    };
  }

  /**
   * Public RPC endpoints load-balance across nodes, and a read right after a
   * confirmed transaction can land on a node a block behind. Poll until the
   * chain shows both commitments of this round before comparing anything.
   */
  private async waitForCommitIndices(negotiationId: bigint, buyerIndex: number, sellerIndex: number) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const n = await this.sealed.getNegotiation(negotiationId);
      if (Number(n.buyerCommitIndex) >= buyerIndex && Number(n.sellerCommitIndex) >= sellerIndex) return n;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`chain did not show round commitments ${buyerIndex}/${sellerIndex} in time`);
  }

  /** A reveal is only accepted if it hashes to exactly what that party committed on-chain. */
  private checkReveal(negotiationId: bigint, reveal: Reveal, committed: string, committedIndex: number) {
    const expected = commitmentHash({
      domain: this.domain,
      negotiationId,
      party: reveal.party,
      commitIndex: reveal.commitIndex,
      position: reveal.position,
    });
    if (reveal.commitIndex !== committedIndex || expected !== committed) {
      throw new Error(`reveal from ${reveal.party} does not match its on-chain commitment`);
    }
  }

  private async settle(
    negotiationId: bigint,
    request: NegotiationRequest,
    reveals: { buyer: Reveal; seller: Reveal },
    n: { buyerCommitment: string; sellerCommitment: string; buyerCommitIndex: bigint; sellerCommitIndex: bigint },
  ) {
    const message = {
      negotiationId,
      buyerCommitment: n.buyerCommitment,
      sellerCommitment: n.sellerCommitment,
      buyerCommitIndex: Number(n.buyerCommitIndex),
      sellerCommitIndex: Number(n.sellerCommitIndex),
    };
    const [buyerAuth, sellerAuth] = await Promise.all([
      request.buyer.agent.authorize(message),
      request.seller.agent.authorize(message),
    ]);
    const tx = await this.sealed.settle(
      negotiationId,
      reveals.buyer.position,
      reveals.seller.position,
      buyerAuth,
      sellerAuth,
      await chainFees(this.relayer.provider!),
    );
    await tx.wait();
    // The contract's price rule, recomputed here rather than read back from a
    // possibly lagging node: the midpoint of two numbers that cross.
    const floor = reveals.seller.position.offer;
    const price = floor + (reveals.buyer.position.offer - floor) / 2n;
    return { settleTx: tx.hash as string, settledPrice: price.toString() };
  }

  private async expireAfterDeadline(negotiationId: bigint, deadline: bigint, log: (m: string) => void) {
    const provider = this.relayer.provider!;
    // A few seconds of margin, because a load-balanced RPC may serve a node that
    // is a block or two behind and still think the deadline is in the future.
    const target = deadline + 4n;
    for (;;) {
      const now = BigInt((await provider.getBlock("latest"))!.timestamp);
      if (now >= target) break;
      const waitMs = Number(target - now) * 1000 + 2000;
      log(`waiting ${Math.ceil(waitMs / 1000)}s for the deadline`);
      await this.sleep(Math.min(waitMs, 30_000));
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const tx = await this.sealed.expire(negotiationId, await chainFees(provider));
        await tx.wait();
        log(`expired, neither number ever went on-chain`);
        return tx.hash as string;
      } catch (error) {
        lastError = error;
        await this.sleep(3000);
      }
    }
    throw new Error(`could not expire negotiation ${negotiationId}: ${String(lastError)}`);
  }
}
