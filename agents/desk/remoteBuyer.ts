import { getAddress, verifyTypedData, type BaseWallet } from "ethers";
import type { Decision, Reveal } from "../negotiator/negotiator";
import { STANCES, type Stance } from "../negotiator/tools";
import type { Party } from "../relay/party";
import {
  assertSalt,
  commitTypedData,
  commitmentHash,
  openNegotiationTypedData,
  settleAuthorizationTypedData,
  type OpenNegotiationMessage,
  type SealedDomain,
  type SettleAuthorizationMessage,
} from "../sealed/commitment";
import { submitCommit } from "./submit";

/** What the desk is waiting for from the guest, as the guest reads it. bigints as decimal strings. */
export type PendingRequest =
  | { kind: "consent"; message: Record<string, string> }
  | { kind: "commit"; round: number; negotiationId: string; commitIndex: number }
  | { kind: "reveal"; round: number }
  | { kind: "authorize"; round: number; message: Record<string, string | number> };

type Answer = Record<string, unknown>;

interface Waiter {
  request: PendingRequest;
  /** Validates the guest's answer; throwing rejects that answer (HTTP 400) and keeps waiting. */
  accept: (answer: Answer) => unknown;
  resolve: (value: unknown) => void;
}

const wire = (o: object) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const hex = (v: unknown, bytes: number, what: string) => {
  if (typeof v !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)) throw new Error(`${what}: expected ${bytes} bytes of hex`);
  return v;
};
const signature = (v: unknown) => hex(v, 65, "signature");

/**
 * The buyer's side of a desk negotiation, for a guest agent that is not online
 * to be called. The relay calls this Party as it calls any other; each call
 * turns into a request the guest reads with GET /v1/sessions/:id and answers
 * with a POST, and every answer is checked here before the relay sees it:
 * signatures must recover to the guest's wallet, a reveal must hash to the
 * commitment the guest signed.
 *
 * The guest holds its own key and its own limit. The desk receives a signed
 * commitment first, submits it with commitOfferBySig (so the guest needs no
 * gas), and only gets the offer behind it once both commitments of the round
 * are on-chain, which the guest's client checks on its own before revealing.
 */
export class RemoteBuyerParty implements Party {
  readonly wallet: { readonly address: string };
  private waiter?: Waiter;
  private signed?: { round: number; commitment: string; signature: string; stance: Stance };
  private committed?: { negotiationId: bigint; commitIndex: number; commitment: string };

  constructor(
    walletAddress: string,
    private readonly submitter: BaseWallet,
    private readonly domain: SealedDomain,
  ) {
    this.wallet = { address: getAddress(walletAddress) };
  }

  /** What the desk is waiting for, if anything. */
  get pending(): PendingRequest | undefined {
    return this.waiter?.request;
  }

  /** The guest's answer to the pending request. Throws when it is not the awaited one or does not check out. */
  answer(kind: PendingRequest["kind"], round: number | undefined, body: Answer) {
    const w = this.waiter;
    if (!w || w.request.kind !== kind) throw new Error(`the desk is not waiting for ${kind}${w ? `; it is waiting for ${w.request.kind}` : ""}`);
    if ("round" in w.request && w.request.round !== round) throw new Error(`the desk is waiting for round ${w.request.round}, not ${round}`);
    const value = w.accept(body);
    this.waiter = undefined;
    w.resolve(value);
  }

  private ask<T>(request: PendingRequest, accept: (answer: Answer) => T): Promise<T> {
    return new Promise<T>((resolve) => {
      this.waiter = { request, accept, resolve: resolve as (v: unknown) => void };
    });
  }

  private recovers(typed: { domain: any; types: any; message: any }, sig: string, what: string) {
    const signer = verifyTypedData(typed.domain, typed.types, typed.message, sig);
    if (signer.toLowerCase() !== this.wallet.address.toLowerCase()) throw new Error(`${what} is not signed by ${this.wallet.address}`);
  }

  consent(message: OpenNegotiationMessage): Promise<string> {
    const typed = openNegotiationTypedData(this.domain, message);
    return this.ask({ kind: "consent", message: wire(message) }, (a) => {
      const sig = signature(a.signature);
      this.recovers({ ...typed, types: { OpenNegotiation: [...typed.types.OpenNegotiation] } }, sig, "consent");
      return sig;
    });
  }

  /** The guest's decision is a signed commitment; its offer stays with the guest until the reveal. */
  async decide(round: number, negotiationId?: bigint): Promise<Decision> {
    if (negotiationId === undefined) throw new Error("remote buyer: decide needs the negotiation id");
    this.signed = await this.ask({ kind: "commit", round, negotiationId: negotiationId.toString(), commitIndex: round }, (a) => {
      const commitment = hex(a.commitment, 32, "commitment");
      const sig = signature(a.signature);
      const typed = commitTypedData(this.domain, { negotiationId, commitment, commitIndex: round });
      this.recovers({ ...typed, types: { Commit: [...typed.types.Commit] } }, sig, "commit");
      const stance = STANCES.includes(a.stance as Stance) ? (a.stance as Stance) : "concede";
      return { round, commitment, signature: sig, stance };
    });
    return {
      round,
      stance: this.signed.stance,
      // Not used: the relay records the offer from the checked reveal.
      offer: 0n,
      explanation: "A guest agent at the desk. It decided on its own machine and sent a signed commitment.",
      steps: [],
    };
  }

  async commit(negotiationId: bigint, commitIndex: number) {
    const s = this.signed;
    if (!s || s.round !== commitIndex) throw new Error("remote buyer: no signed commitment for this round");
    const txHash = await submitCommit(this.submitter, this.domain.verifyingContract, negotiationId, this.wallet.address, s.commitment, s.signature);
    this.committed = { negotiationId, commitIndex, commitment: s.commitment };
    return { txHash, commitment: s.commitment };
  }

  reveal(): Promise<Reveal> {
    const c = this.committed;
    if (!c) throw new Error("remote buyer: nothing committed");
    return this.ask({ kind: "reveal", round: c.commitIndex }, (a) => {
      if (!/^\d+$/.test(String(a.offer ?? ""))) throw new Error("offer: expected a non-negative integer");
      const salt = hex(a.salt, 32, "salt");
      assertSalt(salt);
      const reveal: Reveal = { party: this.wallet.address, commitIndex: c.commitIndex, position: { offer: BigInt(String(a.offer)), salt } };
      const recomputed = commitmentHash({ domain: this.domain, negotiationId: c.negotiationId, party: reveal.party, commitIndex: reveal.commitIndex, position: reveal.position });
      if (recomputed !== c.commitment) throw new Error("reveal does not hash to the commitment you signed");
      return reveal;
    });
  }

  authorize(message: SettleAuthorizationMessage): Promise<string> {
    const typed = settleAuthorizationTypedData(this.domain, message);
    return this.ask({ kind: "authorize", round: message.buyerCommitIndex, message: wire(message) }, (a) => {
      const sig = signature(a.signature);
      this.recovers({ ...typed, types: { SettleAuthorization: [...typed.types.SettleAuthorization] } }, sig, "authorization");
      return sig;
    });
  }
}
