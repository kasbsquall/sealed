import express from "express";
import { timingSafeEqual } from "crypto";
import type { Server } from "http";
import type { AddressInfo } from "net";
import type { Decision, NegotiatorAgent, Reveal } from "../negotiator/negotiator";
import type { SettleAuthorizationMessage } from "../sealed/commitment";

/**
 * What the clearing relay needs from each side of a negotiation. A
 * NegotiatorAgent in the same process satisfies it, and so does an HttpParty
 * talking to an agent that runs in its own process, with its own key and its
 * own model, so the relay never holds anything that could sign for a party.
 */
export interface Party {
  readonly wallet: { readonly address: string };
  decide(round: number, negotiationId?: bigint): Promise<Decision>;
  commit(negotiationId: bigint, commitIndex: number): Promise<{ txHash: string; commitment: string }>;
  reveal(): Reveal | Promise<Reveal>;
  authorize(message: SettleAuthorizationMessage): Promise<string>;
  /** After a settlement: rate the other party in ERC-8004. Optional; a party that cannot simply refuses. */
  rateCounterparty?(settleTx: string): Promise<string>;
}

// JSON has no bigint: every bigint crosses the wire as a decimal string.
type Wire<T> = T extends bigint ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

const toWire = <T,>(value: T): Wire<T> => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const decisionFromWire = ({ proposedOffer, ...d }: Wire<Decision>): Decision => ({
  ...d,
  offer: BigInt(d.offer),
  ...(proposedOffer !== undefined ? { proposedOffer: BigInt(proposedOffer) } : {}),
});
const revealFromWire = (r: Wire<Reveal>): Reveal => ({ ...r, position: { ...r.position, offer: BigInt(r.position.offer) } });
const messageFromWire = (m: Wire<SettleAuthorizationMessage>): SettleAuthorizationMessage => ({ ...m, negotiationId: BigInt(m.negotiationId) });

/** The relay's side: an agent reached over HTTP on this machine. */
export class HttpParty implements Party {
  private constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly wallet: { readonly address: string },
  ) {}

  /** `token` is the secret the agent was started with; without it every route answers 401. */
  static async connect(baseUrl: string, token: string): Promise<HttpParty> {
    const { address } = await HttpParty.call<{ address: string }>(baseUrl, token, "identity", {});
    return new HttpParty(baseUrl, token, { address });
  }

  private static async call<T>(baseUrl: string, token: string, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`agent at ${baseUrl} refused ${path}: ${payload.error ?? response.status}`);
    return payload as T;
  }

  async decide(round: number, negotiationId?: bigint) {
    return decisionFromWire(
      await HttpParty.call<Wire<Decision>>(this.baseUrl, this.token, "decide", { round, negotiationId: negotiationId?.toString() }),
    );
  }

  commit(negotiationId: bigint, commitIndex: number) {
    return HttpParty.call<{ txHash: string; commitment: string }>(this.baseUrl, this.token, "commit", { negotiationId: negotiationId.toString(), commitIndex });
  }

  async reveal() {
    return revealFromWire(await HttpParty.call<Wire<Reveal>>(this.baseUrl, this.token, "reveal", {}));
  }

  async authorize(message: SettleAuthorizationMessage) {
    const { signature } = await HttpParty.call<{ signature: string }>(this.baseUrl, this.token, "authorize", toWire(message));
    return signature;
  }

  async rateCounterparty(settleTx: string) {
    const { txHash } = await HttpParty.call<{ txHash: string }>(this.baseUrl, this.token, "rate", { settleTx });
    return txHash;
  }
}

/**
 * The agent's side: serves one NegotiatorAgent on 127.0.0.1 only. The key stays
 * in this process; the relay gets a commitment, then a reveal once the
 * commitment is on-chain, then a signature over the round's pair of
 * commitments, every round, before the relay compares anything. The steps
 * recorded with each decision quote the agent's limit (check_offer and
 * rejections mention it), so the relay, already trusted with both numbers of a
 * round, sees the limit too.
 */
export function serveParty(agent: NegotiatorAgent, token: string, port = 0): Promise<Server> {
  if (token.length < 32) throw new Error("serveParty needs a random token of at least 32 characters");
  const expected = Buffer.from(`Bearer ${token}`);
  const app = express().use(express.json());
  // Only the relay holds the token. Anyone else on the machine, the other
  // agent's process included, gets 401 from every route, /reveal above all.
  app.use((req, res, next) => {
    const given = Buffer.from(req.get("authorization") ?? "");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.status(401).json({ error: "unauthorized" });
  });
  // A reveal is handed out once per commitment, so a leaked token cannot be
  // used later to read a position the relay already has.
  const revealed = new Set<number>();
  const handle = (path: string, run: (body: any) => Promise<unknown> | unknown) =>
    app.post(`/${path}`, async (req, res) => {
      try {
        res.json(toWire(await run(req.body)));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  handle("identity", () => ({ address: agent.wallet.address }));
  handle("decide", (b) => agent.decide(Number(b.round), b.negotiationId === undefined ? undefined : BigInt(b.negotiationId)));
  handle("commit", (b) => agent.commit(BigInt(b.negotiationId), Number(b.commitIndex)));
  handle("reveal", () => {
    const reveal = agent.reveal();
    if (revealed.has(reveal.commitIndex)) throw new Error(`commitment ${reveal.commitIndex} was already revealed`);
    revealed.add(reveal.commitIndex);
    return reveal;
  });
  handle("authorize", async (b) => ({ signature: await agent.authorize(messageFromWire(b)) }));
  handle("rate", async (b) => ({ txHash: await agent.rateCounterparty(String(b.settleTx)) }));
  return new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });
}

export const serverUrl = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
