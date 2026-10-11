import { Contract, getAddress, type BaseWallet, type Provider } from "ethers";
import {
  commitTypedData,
  commitmentHash,
  newSalt,
  openNegotiationTypedData,
  settleAuthorizationTypedData,
  type SealedDomain,
} from "../sealed/commitment";
import { admissionPolicyHash, type Policy } from "../sealed/policy";

/**
 * A guest's side of the Sealed desk, for any agent: an MCP server, a script,
 * an agent framework. It holds the key and the limit; neither leaves it. It
 * checks every request from the desk before signing, and reads the chain on
 * its own: it reveals an offer only after both commitments of the round are
 * on-chain, so the desk's seller has committed before anyone sees the number.
 */
export interface DeskClientOptions {
  url: string;
  /** Signs only. Needs no MON: the desk submits everything. */
  key: BaseWallet;
  /** Read-only chain access, independent of the desk. */
  provider: Provider;
  /** The SealedNegotiationV3 this client is willing to sign for. Refuses a desk that names another. */
  expectedContract?: string;
  pollMs?: number;
  waitMs?: number;
}

export interface DeskInfo {
  contracts: { sealedNegotiation: string; token: string; identityRegistry: string };
  eip712: { chainId: string; verifyingContract: string };
  terms: string;
  termsSchema: string;
  unit: string;
  payment: { token: string; scale: string; calls: string };
  policy: { reviewers: string[]; minFeedbackCount: string; minAverageValue: string; decimals: number; tag1: string };
  policyHash: string;
  seller: { agentId: string | null; wallet: string; listPrice: string; rule: string };
  maxRounds: number;
  windowSeconds: number;
  trust: string;
  [k: string]: unknown;
}

export interface RoundResult {
  round: number;
  crossed: boolean;
  status: string;
  roundsLeft: number;
  settledPrice?: string;
  amount?: string;
  fee?: string;
  transactions?: Record<string, string>;
  abortReason?: string;
}

interface Session {
  id: string;
  status: "waiting" | "open" | "closing" | "settled" | "expired" | "aborted";
  negotiationId?: string;
  rounds: { round: number; crossed: boolean }[];
  pending: null | { kind: string; round?: number; message?: Record<string, any>; negotiationId?: string; commitIndex?: number };
  settledPrice?: string;
  amount?: string;
  fee?: string;
  transactions: Record<string, string>;
  abortReason?: string;
  events?: string[];
}

const READ_ABI = [
  "function getNegotiation(uint256 negotiationId) view returns ((address buyerWallet, address sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 buyerCommitIndex, uint32 sellerCommitIndex, uint64 deadline, uint8 status, uint256 settledPrice, bytes32 termsSchema, bytes32 policyHash))",
];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DeskClient {
  private info?: DeskInfo;
  private negotiation?: { sessionId: string; negotiationId: bigint; limit: bigint; lastOffer?: bigint; round: number };
  private readonly pollMs: number;
  private readonly waitMs: number;

  constructor(private readonly options: DeskClientOptions) {
    this.pollMs = options.pollMs ?? 1500;
    this.waitMs = options.waitMs ?? 6 * 60_000;
  }

  get address() {
    return this.options.key.address;
  }

  get current() {
    const n = this.negotiation;
    return n && { sessionId: n.sessionId, negotiationId: n.negotiationId.toString(), round: n.round, lastOffer: n.lastOffer?.toString() };
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.options.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(`desk refused ${method} ${path}: ${payload.error ?? response.status}`);
    return payload as T;
  }

  private domain(): SealedDomain {
    const info = this.info!;
    return { chainId: BigInt(info.eip712.chainId), verifyingContract: info.eip712.verifyingContract };
  }

  /** Reads the desk's listing and checks it is internally consistent and names the expected contract. */
  async describe(): Promise<DeskInfo> {
    const info = await this.call<DeskInfo>("GET", "/v1/desk");
    const policy: Policy = { ...info.policy, minFeedbackCount: BigInt(info.policy.minFeedbackCount), minAverageValue: BigInt(info.policy.minAverageValue) };
    if (admissionPolicyHash(policy) !== info.policyHash) throw new Error("desk listing: policyHash does not match its policy");
    if (!same(info.eip712.verifyingContract, info.contracts.sealedNegotiation)) throw new Error("desk listing: EIP-712 domain names another contract");
    if (this.options.expectedContract && !same(info.contracts.sealedNegotiation, this.options.expectedContract)) {
      throw new Error(`desk names contract ${info.contracts.sealedNegotiation}, not ${this.options.expectedContract}`);
    }
    const chainId = (await this.options.provider.getNetwork()).chainId;
    if (chainId.toString() !== info.eip712.chainId) throw new Error(`desk is on chain ${info.eip712.chainId}, this provider on ${chainId}`);
    this.info = info;
    return info;
  }

  /** A guest ERC-8004 identity: the desk registers it and pays; this wallet signs to become its wallet. */
  async join(): Promise<{ agentId: string; transactions: Record<string, string> }> {
    const info = this.info ?? (await this.describe());
    const me = this.address;
    const { agentId, typedData } = await this.call<{ agentId: string; typedData: any }>("POST", "/v1/guests", { wallet: me });
    const { domain, types, message } = typedData;
    if (!same(domain.verifyingContract, info.contracts.identityRegistry) || !same(message.newWallet, me) || message.agentId !== agentId) {
      throw new Error("desk asked to sign a wallet binding for something else");
    }
    const signature = await this.options.key.signTypedData(domain, types, message);
    return this.call("POST", `/v1/guests/${agentId}`, { wallet: me, deadline: message.deadline, signature });
  }

  private async session(id: string) {
    return this.call<Session>("GET", `/v1/sessions/${id}`);
  }

  /** Polls the session until `done` returns something, or the session ends without it. */
  private async until<T>(id: string, done: (s: Session) => T | undefined, what: string): Promise<T> {
    const stop = Date.now() + this.waitMs;
    for (;;) {
      const s = await this.session(id);
      const value = done(s);
      if (value !== undefined) return value;
      if (s.status === "aborted" || s.status === "expired" || s.status === "settled" || s.status === "closing") {
        const reason = s.abortReason ?? (s as any).events?.find((e: string) => /aborted:/.test(e));
        throw new Error(`negotiation ended (${s.status}${reason ? `: ${reason}` : ""}) while waiting for ${what}`);
      }
      if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
      await sleep(this.pollMs);
    }
  }

  /**
   * Opens a paid negotiation. `limit` is the most this buyer pays, in the
   * desk's unit; it stays here and every offer is checked against it.
   */
  async open(agentId: string, limit: bigint) {
    const info = this.info ?? (await this.describe());
    const me = this.address;
    const { id } = await this.call<{ id: string }>("POST", "/v1/sessions", { agentId, wallet: me });
    const message = await this.until(id, (s) => (s.pending?.kind === "consent" ? s.pending.message : undefined), "the terms to sign");
    const now = BigInt((await this.options.provider.getBlock("latest"))!.timestamp);
    const terms = {
      buyerAgentId: BigInt(message!.buyerAgentId),
      buyerWallet: getAddress(message!.buyerWallet),
      sellerAgentId: BigInt(message!.sellerAgentId),
      sellerWallet: getAddress(message!.sellerWallet),
      deadline: BigInt(message!.deadline),
      termsSchema: message!.termsSchema,
      policyHash: message!.policyHash,
      token: getAddress(message!.token),
      scale: BigInt(message!.scale),
    };
    if (!same(terms.buyerWallet, me) || terms.buyerAgentId.toString() !== agentId) throw new Error("terms name another buyer");
    if (!same(terms.sellerWallet, info.seller.wallet)) throw new Error("terms name a seller other than the desk's");
    if (terms.termsSchema !== info.termsSchema || !same(terms.token, info.payment.token) || terms.scale.toString() !== info.payment.scale || terms.policyHash !== info.policyHash) {
      throw new Error("terms differ from the desk's listing");
    }
    if (terms.deadline <= now + 60n || terms.deadline > now + 7n * 86400n) throw new Error("terms carry an unreasonable deadline");
    const typed = openNegotiationTypedData(this.domain(), terms);
    const signature = await this.options.key.signTypedData(typed.domain, { OpenNegotiation: [...typed.types.OpenNegotiation] }, typed.message);
    await this.call("POST", `/v1/sessions/${id}/consent`, { signature });
    const negotiationId = await this.until(id, (s) => s.negotiationId, "the negotiation to open");
    this.negotiation = { sessionId: id, negotiationId: BigInt(negotiationId), limit, round: 0 };
    return { sessionId: id, negotiationId, deadline: terms.deadline.toString(), maxRounds: info.maxRounds };
  }

  /**
   * Plays one round with `offer`. Signs a commitment, waits until both
   * commitments are on-chain (read from the chain, not from the desk), reveals,
   * checks and signs the settlement authorization, and returns whether the
   * round crossed and, if it did, what was paid.
   */
  async offer(offer: bigint, stance = "concede"): Promise<RoundResult> {
    const n = this.negotiation;
    if (!n) throw new Error("no open negotiation; open one first");
    if (offer > n.limit) throw new Error(`offer ${offer} is above this buyer's limit`);
    if (n.lastOffer !== undefined && offer < n.lastOffer) throw new Error(`offer ${offer} is below last round's ${n.lastOffer}; a buyer does not go back down`);
    const info = this.info!;
    const domain = this.domain();
    const me = this.address;
    const id = n.sessionId;

    const round = await this.until(id, (s) => (s.pending?.kind === "commit" ? s.pending.round : undefined), "the next round");
    if (round !== n.round + 1) throw new Error(`desk is at round ${round}, expected ${n.round + 1}`);
    const position = { offer, salt: newSalt() };
    const commitment = commitmentHash({ domain, negotiationId: n.negotiationId, party: me, commitIndex: round, position });
    const commitTyped = commitTypedData(domain, { negotiationId: n.negotiationId, commitment, commitIndex: round });
    const commitSig = await this.options.key.signTypedData(commitTyped.domain, { Commit: [...commitTyped.types.Commit] }, commitTyped.message);
    await this.call("POST", `/v1/sessions/${id}/commit`, { round, commitment, signature: commitSig, stance });
    n.round = round;
    n.lastOffer = offer;

    // The reveal waits for the chain: both of this round's commitments, ours as signed.
    const sealed = new Contract(info.contracts.sealedNegotiation, READ_ABI, this.options.provider);
    const stop = Date.now() + this.waitMs;
    let onChain: any;
    for (;;) {
      onChain = await sealed.getNegotiation(n.negotiationId);
      if (Number(onChain.buyerCommitIndex) >= round && Number(onChain.sellerCommitIndex) >= round) break;
      const s = await this.session(id);
      if (s.status !== "open") throw new Error(`negotiation ${s.status} before both commitments reached the chain; nothing revealed${s.events?.length ? `: ${s.events.at(-1)}` : ""}`);
      if (Date.now() > stop) throw new Error("both commitments did not reach the chain in time; nothing revealed");
      await sleep(this.pollMs);
    }
    if (Number(onChain.buyerCommitIndex) !== round || Number(onChain.sellerCommitIndex) !== round || onChain.buyerCommitment !== commitment) {
      throw new Error("the chain does not show this round's commitments as expected; nothing revealed");
    }
    await this.until(id, (s) => (s.pending?.kind === "reveal" && s.pending.round === round ? true : undefined), "the desk to ask for the reveal");
    await this.call("POST", `/v1/sessions/${id}/reveal`, { round, offer: offer.toString(), salt: position.salt });

    const m = await this.until(id, (s) => (s.pending?.kind === "authorize" && s.pending.round === round ? s.pending.message : undefined), "the authorization request");
    const message = {
      negotiationId: BigInt(m!.negotiationId),
      buyerCommitment: m!.buyerCommitment as string,
      sellerCommitment: m!.sellerCommitment as string,
      buyerCommitIndex: Number(m!.buyerCommitIndex),
      sellerCommitIndex: Number(m!.sellerCommitIndex),
    };
    if (
      message.negotiationId !== n.negotiationId ||
      message.buyerCommitment !== commitment ||
      message.sellerCommitment !== onChain.sellerCommitment ||
      message.buyerCommitIndex !== round ||
      message.sellerCommitIndex !== round
    ) {
      throw new Error("authorization request does not match this round on-chain; not signed");
    }
    const authTyped = settleAuthorizationTypedData(domain, message);
    const authSig = await this.options.key.signTypedData(authTyped.domain, { SettleAuthorization: [...authTyped.types.SettleAuthorization] }, authTyped.message);
    await this.call("POST", `/v1/sessions/${id}/authorize`, { round, signature: authSig });

    // Crossed: wait for the settlement. Not crossed: the round's bit is the answer.
    const s = await this.waitForResult(id, round);
    const crossed = s.rounds.find((r) => r.round === round)?.crossed ?? false;
    return {
      round,
      crossed,
      status: s.status,
      roundsLeft: Math.max(0, info.maxRounds - round),
      ...(s.status === "settled" ? { settledPrice: s.settledPrice, amount: s.amount, fee: s.fee, transactions: s.transactions } : {}),
      ...(s.abortReason ? { abortReason: s.abortReason } : {}),
    };
  }

  private async waitForResult(id: string, round: number): Promise<Session> {
    const stop = Date.now() + this.waitMs;
    for (;;) {
      const s = await this.session(id);
      const r = s.rounds.find((x) => x.round === round);
      if (s.status === "settled" || s.status === "aborted" || s.status === "expired" || s.status === "closing") return s;
      if (r && !r.crossed) return s;
      if (Date.now() > stop) throw new Error("timed out waiting for the round's result");
      await sleep(this.pollMs);
    }
  }

  async status() {
    const n = this.negotiation;
    if (!n) throw new Error("no negotiation opened from this client");
    const { pending: _p, ...s } = await this.session(n.sessionId);
    return s;
  }
}
