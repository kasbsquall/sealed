import fs from "fs";
import { randomBytes } from "crypto";
import { Contract, MaxUint256, getAddress, type BaseWallet } from "ethers";
import { ClearingRelay, type NegotiationRecord, type RelayTimeouts } from "../relay/clearingRelay";
import type { SealedDomain } from "../sealed/commitment";
import { chainFees } from "../sealed/fees";
import { admissionPolicyHash, type Policy } from "../sealed/policy";
import { RemoteBuyerParty, type PendingRequest } from "./remoteBuyer";
import { DeskSeller, askFor, drawFloor, type DeskListing } from "./seller";

/**
 * A public negotiating desk: any agent with a key and no MON can negotiate a
 * paid Sealed deal against the desk's seller. The desk pays every gas fee:
 * it registers the guest's ERC-8004 identity, funds its escrow with test
 * dollars, opens the negotiation on the terms both sides signed, submits both
 * sides' commitments, and settles. The guest signs; it never sends a
 * transaction.
 *
 * Trust, said plainly: the desk runs the relay and the seller, so the guest
 * trusts it with confidentiality as it would any relay (it sees both numbers of
 * a round). It never trusts it with the deal: nothing settles or pays without
 * the guest's signature over its own committed number. The seller follows a
 * fixed schedule (seller.ts) that never reads anything the guest sent.
 */
export interface DeskConfig {
  /**
   * Pays every fee. Also the owner of guest identities, which it registers for
   * them. Use a SerialWallet: the relay sends both sides' commits at once.
   */
  operator: BaseWallet;
  /** The seller's key. Signs only; the operator submits for it. */
  sellerKey: BaseWallet;
  chainId: bigint;
  contracts: { sealed: string; token: string; identity: string };
  terms: string;
  termsSchema: string;
  unit: string;
  scale: bigint;
  calls: bigint;
  listing: Omit<DeskListing, "termsSchema" | "token" | "scale" | "policyHash">;
  /** Each negotiation's floor is drawn from [listing.floor, listing.floor + floorSpread]; both stay private. */
  floorSpread?: bigint;
  /** Open admission: no reviews required, so a new identity is admitted. The gate still checks the wallet. */
  policy: Policy;
  /** Test dollars put in each guest's escrow: covers any price up to the list price. */
  guestFloat: bigint;
  windowSeconds: number;
  limits: { maxOpenSessions: number; maxGuestsPerDay: number; maxSessionsPerDay: number; minOperatorBalance: bigint };
  dataFile: string;
  timeouts?: Partial<RelayTimeouts>;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  wallet: string;
  createdAt: string;
  /** closing: no more rounds (a round failed, or none crossed); the desk expires it at the deadline. */
  status: "waiting" | "open" | "closing" | "settled" | "expired" | "aborted";
  negotiationId?: string;
  rounds: { round: number; crossed: boolean }[];
  settledPrice?: string;
  amount?: string;
  fee?: string;
  transactions: Record<string, string>;
  abortReason?: string;
}

interface GuestRecord {
  agentId: string;
  wallet?: string;
  createdAt: string;
  transactions: Record<string, string>;
}

interface DeskData {
  seller?: { agentId: string; wallet: string; transactions: Record<string, string> };
  guests: GuestRecord[];
  sessions: SessionSummary[];
}

const IDENTITY_ABI = [
  "function register() returns (uint256 agentId)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
];
const TOKEN_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];
const ESCROW_ABI = [
  "function depositFor(address token, address account, uint256 amount)",
  "function escrowOf(address token, address account) view returns (uint256)",
  "function openAsBuyer(address account) view returns (uint256)",
];
const MINT_CAP = 1_000_000n * 1_000_000n;
/** The identity registry accepts an AgentWalletSet signature for at most 5 minutes. */
const WALLET_SIGNATURE_SECONDS = 240n;

export class Desk {
  readonly domain: SealedDomain;
  readonly listing: DeskListing;
  private readonly relay: ClearingRelay;
  private readonly identity: Contract;
  private readonly token: Contract;
  private readonly escrow: Contract;
  private readonly data: DeskData;
  private readonly live = new Map<string, { buyer: RemoteBuyerParty; events: string[] }>();

  constructor(private readonly config: DeskConfig) {
    this.domain = { chainId: config.chainId, verifyingContract: config.contracts.sealed };
    this.listing = {
      ...config.listing,
      termsSchema: config.termsSchema,
      token: config.contracts.token,
      scale: config.scale,
      policyHash: admissionPolicyHash(config.policy),
    };
    // Fails at start, not mid-negotiation, if the private range is unusable.
    drawFloor(config.listing.floor, config.floorSpread ?? 0n, config.listing.listPrice, config.listing.finalMargin);
    this.relay = new ClearingRelay(config.operator, this.domain, undefined, config.timeouts);
    this.identity = new Contract(config.contracts.identity, IDENTITY_ABI, config.operator);
    this.token = new Contract(config.contracts.token, TOKEN_ABI, config.operator);
    this.escrow = new Contract(config.contracts.sealed, ESCROW_ABI, config.operator);
    this.data = fs.existsSync(config.dataFile)
      ? JSON.parse(fs.readFileSync(config.dataFile, "utf8"))
      : { guests: [], sessions: [] };
    // A restart loses the guest's half of any live session; say so instead of showing it open forever.
    for (const s of this.data.sessions) {
      if (s.status === "waiting" || s.status === "open" || s.status === "closing") Object.assign(s, { status: "aborted", abortReason: "the desk restarted" });
    }
  }

  private save() {
    fs.writeFileSync(this.config.dataFile, JSON.stringify(this.data, null, 2));
  }

  private async tx(call: (fees: object) => Promise<any>) {
    const tx = await call(await chainFees(this.config.operator.provider!));
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`transaction failed: ${tx.hash}`);
    return receipt;
  }

  /** Registers the desk's own seller identity once, and approves the escrow for guest floats. */
  async prepare() {
    if (!this.data.seller) {
      const { agentId, txHash } = await this.registerIdentity();
      const setTx = await this.bindWallet(agentId, this.config.sellerKey);
      this.data.seller = { agentId: agentId.toString(), wallet: this.config.sellerKey.address, transactions: { register: txHash, setAgentWallet: setTx } };
      this.save();
    }
    const allowance: bigint = await this.token.allowance(this.config.operator.address, this.config.contracts.sealed);
    if (allowance < this.config.guestFloat * 100n) {
      await this.tx((f) => this.token.approve(this.config.contracts.sealed, MaxUint256, f));
    }
  }

  get sellerAgentId(): bigint {
    if (!this.data.seller) throw new Error("desk not prepared");
    return BigInt(this.data.seller.agentId);
  }

  /** Everything a guest needs to decide whether to negotiate here. The seller's floor is not in it. */
  info() {
    const c = this.config;
    return {
      name: "Sealed desk",
      network: { chainId: c.chainId.toString(), rpc: "https://testnet-rpc.monad.xyz", explorer: "https://testnet.monadvision.com" },
      contracts: { sealedNegotiation: c.contracts.sealed, token: c.contracts.token, identityRegistry: c.contracts.identity },
      eip712: { name: "Sealed", version: "1", chainId: c.chainId.toString(), verifyingContract: c.contracts.sealed },
      terms: c.terms,
      termsSchema: c.termsSchema,
      unit: c.unit,
      payment: {
        token: c.contracts.token,
        tokenNote: "SealedTestUSD (tUSD): a test dollar with no value, 6 decimals",
        scale: c.scale.toString(),
        calls: c.calls.toString(),
        rule: "settledPrice * scale tUSD base units move from the buyer's escrow at settlement; the seller receives it less 0.25%, the treasury the 0.25%",
      },
      policy: { ...c.policy, minFeedbackCount: c.policy.minFeedbackCount.toString(), minAverageValue: c.policy.minAverageValue.toString() },
      policyHash: this.listing.policyHash,
      seller: {
        agentId: this.data.seller?.agentId ?? null,
        wallet: c.sellerKey.address,
        listPrice: c.listing.listPrice.toString(),
        rule: "Round 1 asks the list price; each later round gives up 60% of the remaining gap to a floor the desk keeps private and draws anew for each negotiation, and never goes below that floor plus a margin. Source: agents/desk/seller.ts",
      },
      maxRounds: c.listing.maxRounds,
      windowSeconds: c.windowSeconds,
      guestFloat: c.guestFloat.toString(),
      trust:
        "The desk runs the relay and the seller, so it sees both numbers of each round, as any Sealed relay does. It cannot settle or move funds without your signature over your own committed number, and you reveal only after both commitments are on-chain.",
    };
  }

  private countToday<T extends { createdAt: string }>(items: T[]) {
    const day = new Date().toISOString().slice(0, 10);
    return items.filter((i) => i.createdAt.startsWith(day)).length;
  }

  private async requireBudget() {
    const balance = await this.config.operator.provider!.getBalance(this.config.operator.address);
    if (balance < this.config.limits.minOperatorBalance) throw new DeskError(503, "the desk is out of test MON for today; try again later");
  }

  private async registerIdentity() {
    const receipt = await this.tx((f) => this.identity["register()"](f));
    const log = receipt.logs.map((l: any) => { try { return this.identity.interface.parseLog(l); } catch { return null; } }).find((p: any) => p?.name === "Registered");
    if (!log) throw new Error("no Registered event");
    return { agentId: log.args.agentId as bigint, txHash: receipt.hash as string };
  }

  private walletTyped(agentId: bigint, wallet: string, deadline: bigint) {
    return {
      domain: { name: "ERC8004IdentityRegistry", version: "1", chainId: this.config.chainId, verifyingContract: this.config.contracts.identity },
      types: { AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ] },
      message: { agentId, newWallet: getAddress(wallet), owner: this.config.operator.address, deadline },
    };
  }

  private async now() {
    return BigInt((await this.config.operator.provider!.getBlock("latest"))!.timestamp);
  }

  private async bindWallet(agentId: bigint, key: BaseWallet) {
    const deadline = (await this.now()) + WALLET_SIGNATURE_SECONDS;
    const typed = this.walletTyped(agentId, key.address, deadline);
    const sig = await key.signTypedData(typed.domain, typed.types, typed.message);
    const receipt = await this.tx((f) => this.identity.setAgentWallet(agentId, key.address, deadline, sig, f));
    return receipt.hash as string;
  }

  /**
   * Step 1 of a guest identity: the desk registers a fresh ERC-8004 agent it
   * owns, and returns what the guest's wallet must sign to become its wallet.
   */
  async startGuest(wallet: string) {
    getAddress(wallet);
    if (this.countToday(this.data.guests) >= this.config.limits.maxGuestsPerDay) throw new DeskError(429, "the desk has registered all the guests it can today");
    await this.requireBudget();
    const { agentId, txHash } = await this.registerIdentity();
    this.data.guests.push({ agentId: agentId.toString(), createdAt: new Date().toISOString(), transactions: { register: txHash } });
    this.save();
    const deadline = (await this.now()) + WALLET_SIGNATURE_SECONDS;
    return { agentId: agentId.toString(), typedData: JSON.parse(JSON.stringify(this.walletTyped(agentId, wallet, deadline), (_k, v) => (typeof v === "bigint" ? v.toString() : v))) };
  }

  /** Step 2: bind the guest's wallet with its signature, and fund its escrow. */
  async finishGuest(agentId: string, wallet: string, deadline: string, signature: string) {
    const guest = this.data.guests.find((g) => g.agentId === agentId);
    if (!guest) throw new DeskError(404, "unknown guest identity; start with POST /v1/guests");
    if (guest.wallet) throw new DeskError(409, "this identity already has its wallet");
    const id = BigInt(agentId);
    const receipt = await this.tx((f) => this.identity.setAgentWallet(id, getAddress(wallet), BigInt(deadline), signature, f));
    guest.wallet = getAddress(wallet);
    guest.transactions.setAgentWallet = receipt.hash;
    const deposit = await this.fund(guest.wallet);
    if (deposit) guest.transactions.deposit = deposit;
    this.save();
    return { agentId, wallet: guest.wallet, transactions: guest.transactions };
  }

  /** Tops up a guest's escrow to the float, minting test dollars as needed. */
  private async fund(wallet: string): Promise<string | undefined> {
    const have: bigint = await this.escrow.escrowOf(this.config.contracts.token, wallet);
    const need = this.config.guestFloat - have;
    if (need <= 0n) return undefined;
    const balance: bigint = await this.token.balanceOf(this.config.operator.address);
    if (balance < need) await this.tx((f) => this.token.mint(this.config.operator.address, MINT_CAP, f));
    const receipt = await this.tx((f) => this.escrow.depositFor(this.config.contracts.token, wallet, need, f));
    return receipt.hash;
  }

  /** Opens a session: the relay starts at once and waits on the guest for each step. */
  async openSession(agentId: string, wallet: string) {
    const id = BigInt(agentId);
    const owner = getAddress(wallet);
    if (getAddress(await this.identity.getAgentWallet(id)) !== owner) throw new DeskError(400, `agent ${agentId}'s registered wallet is not ${owner}`);
    const active = [...this.live.keys()].map((k) => this.data.sessions.find((s) => s.id === k)!).filter((s) => s.status === "waiting" || s.status === "open" || s.status === "closing");
    if (active.some((s) => s.wallet === owner)) throw new DeskError(409, "this wallet already has a session open");
    if (active.length >= this.config.limits.maxOpenSessions) throw new DeskError(429, "the desk is busy; try again in a few minutes");
    if (this.countToday(this.data.sessions) >= this.config.limits.maxSessionsPerDay) throw new DeskError(429, "the desk has run all the negotiations it can today");
    await this.requireBudget();
    // The float must cover the most this deal could cost: the seller never asks more than its list price.
    if ((await this.escrow.escrowOf(this.config.contracts.token, owner)) < askFor(this.listing, 1) * this.config.scale) await this.fund(owner);

    const session: SessionSummary = {
      id: randomBytes(16).toString("hex"),
      agentId,
      wallet: owner,
      createdAt: new Date().toISOString(),
      status: "waiting",
      rounds: [],
      transactions: {},
    };
    const buyer = new RemoteBuyerParty(owner, this.config.operator, this.domain);
    const floor = drawFloor(this.config.listing.floor, this.config.floorSpread ?? 0n);
    const seller = new DeskSeller(this.config.sellerKey, this.config.operator, this.domain, { ...this.listing, floor });
    const events: string[] = [];
    this.live.set(session.id, { buyer, events });
    this.data.sessions.push(session);
    this.save();

    const onEvent = (raw: string) => {
      // Chain errors run to kilobytes; the first line says enough.
      const message = raw.split("\n")[0].replace(/ \(action=.*$/, "").slice(0, 300);
      events.push(message);
      if (/aborted:|waiting \d+s for the deadline/.test(message) && session.status === "open") session.status = "closing";
      const opened = /^negotiation (\d+) opened/.exec(message);
      if (opened) Object.assign(session, { status: "open", negotiationId: opened[1] });
      const round = /^round (\d+): (crossed|did not cross)/.exec(message);
      if (round) session.rounds.push({ round: Number(round[1]), crossed: round[2] === "crossed" });
      this.save();
    };
    void this.relay
        .negotiate({
          buyer: { agent: buyer, agentId: id },
          seller: { agent: seller, agentId: this.sellerAgentId },
          termsSchema: this.config.termsSchema,
          policy: this.config.policy,
          maxRounds: this.config.listing.maxRounds,
          windowSeconds: this.config.windowSeconds,
          payment: { token: this.config.contracts.token, scale: this.config.scale },
          onEvent,
        })
        .then((record) => this.close(session, record))
        .catch((error) => Object.assign(session, { status: "aborted", abortReason: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          this.save();
          setTimeout(() => this.live.delete(session.id), 10 * 60_000).unref();
        });
    return session;
  }

  /** Only what the chain already shows is kept: no offers of rounds that did not settle. */
  private close(session: SessionSummary, record: NegotiationRecord) {
    session.status = record.outcome;
    session.negotiationId = record.negotiationId;
    session.rounds = record.rounds.map((r) => ({ round: r.round, crossed: r.crossed }));
    session.transactions = {
      create: record.createTx,
      ...Object.fromEntries(record.rounds.flatMap((r) => [[`buyerCommit${r.round}`, r.buyer.commitTx], [`sellerCommit${r.round}`, r.seller.commitTx]])),
      ...(record.settleTx ? { settle: record.settleTx } : {}),
      ...(record.expireTx ? { expire: record.expireTx } : {}),
    };
    if (record.outcome === "settled") Object.assign(session, { settledPrice: record.settledPrice, amount: record.payment?.amount, fee: record.payment?.fee });
    if (record.abortReason) session.abortReason = record.abortReason;
  }

  session(id: string) {
    const s = this.data.sessions.find((x) => x.id === id);
    if (!s) throw new DeskError(404, "unknown session");
    const live = this.live.get(id);
    return { ...s, pending: live?.buyer.pending ?? null, events: live?.events ?? [] };
  }

  answer(id: string, kind: PendingRequest["kind"], round: number | undefined, body: Record<string, unknown>) {
    const live = this.live.get(id);
    if (!live) throw new DeskError(404, "no live session with that id");
    try {
      live.buyer.answer(kind, round, body);
    } catch (error) {
      throw new DeskError(400, error instanceof Error ? error.message : String(error));
    }
    return this.session(id);
  }

  /** Public numbers for the site: what guests did here, with transactions to check each one. */
  stats() {
    const done = this.data.sessions.filter((s) => s.status === "settled" || s.status === "expired");
    const settled = done.filter((s) => s.status === "settled");
    const sum = (k: "amount" | "fee") => settled.reduce((t, s) => t + BigInt(s[k] ?? "0"), 0n).toString();
    return {
      guests: this.data.guests.filter((g) => g.wallet).length,
      negotiations: done.length,
      settled: settled.length,
      expired: done.length - settled.length,
      paid: sum("amount"),
      fees: sum("fee"),
      tokenDecimals: 6,
      recent: done.slice(-20).reverse().map(({ id: _id, ...s }) => s),
    };
  }
}

export class DeskError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
