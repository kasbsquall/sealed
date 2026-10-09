import express from "express";
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
  decide(round: number): Promise<Decision>;
  commit(negotiationId: bigint, commitIndex: number): Promise<{ txHash: string; commitment: string }>;
  reveal(): Reveal | Promise<Reveal>;
  authorize(message: SettleAuthorizationMessage): Promise<string>;
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
    readonly wallet: { readonly address: string },
  ) {}

  static async connect(baseUrl: string): Promise<HttpParty> {
    const { address } = await HttpParty.call<{ address: string }>(baseUrl, "identity", {});
    return new HttpParty(baseUrl, { address });
  }

  private static async call<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`agent at ${baseUrl} refused ${path}: ${payload.error ?? response.status}`);
    return payload as T;
  }

  async decide(round: number) {
    return decisionFromWire(await HttpParty.call<Wire<Decision>>(this.baseUrl, "decide", { round }));
  }

  commit(negotiationId: bigint, commitIndex: number) {
    return HttpParty.call<{ txHash: string; commitment: string }>(this.baseUrl, "commit", { negotiationId: negotiationId.toString(), commitIndex });
  }

  async reveal() {
    return revealFromWire(await HttpParty.call<Wire<Reveal>>(this.baseUrl, "reveal", {}));
  }

  async authorize(message: SettleAuthorizationMessage) {
    const { signature } = await HttpParty.call<{ signature: string }>(this.baseUrl, "authorize", toWire(message));
    return signature;
  }
}

/**
 * The agent's side: serves one NegotiatorAgent on 127.0.0.1 only. The key and
 * the mandate stay in this process; the relay gets a commitment, then a reveal
 * once the commitment is on-chain, then a signature if the numbers crossed.
 */
export function serveParty(agent: NegotiatorAgent, port = 0): Promise<Server> {
  const app = express().use(express.json());
  const handle = (path: string, run: (body: any) => Promise<unknown> | unknown) =>
    app.post(`/${path}`, async (req, res) => {
      try {
        res.json(toWire(await run(req.body)));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  handle("identity", () => ({ address: agent.wallet.address }));
  handle("decide", (b) => agent.decide(Number(b.round)));
  handle("commit", (b) => agent.commit(BigInt(b.negotiationId), Number(b.commitIndex)));
  handle("reveal", () => agent.reveal());
  handle("authorize", async (b) => ({ signature: await agent.authorize(messageFromWire(b)) }));
  return new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });
}

export const serverUrl = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
