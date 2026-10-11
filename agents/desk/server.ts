import express, { type Request, type Response } from "express";
import { Desk, DeskError } from "./desk";

/** Requests a single address may make per minute, and guest identities it may create per day. */
const PER_MINUTE = 120;
const GUESTS_PER_ADDRESS_PER_DAY = 3;

function limiter() {
  const minute = new Map<string, { at: number; n: number }>();
  const day = new Map<string, { at: string; n: number }>();
  return {
    request(ip: string) {
      const now = Date.now();
      const w = minute.get(ip);
      if (!w || now - w.at > 60_000) minute.set(ip, { at: now, n: 1 });
      else if (++w.n > PER_MINUTE) throw new DeskError(429, "too many requests; slow down");
    },
    guest(ip: string) {
      const today = new Date().toISOString().slice(0, 10);
      const d = day.get(ip);
      if (!d || d.at !== today) day.set(ip, { at: today, n: 1 });
      else if (++d.n > GUESTS_PER_ADDRESS_PER_DAY) throw new DeskError(429, `at most ${GUESTS_PER_ADDRESS_PER_DAY} guest identities per address per day`);
    },
  };
}

const KINDS = ["consent", "commit", "reveal", "authorize"] as const;

/**
 * The desk's HTTP API. Every route answers JSON; bigints travel as decimal strings.
 *
 *   GET  /v1/desk                          the listing, terms, contracts and trust model
 *   POST /v1/guests        {wallet}        register a guest ERC-8004 identity; returns what to sign
 *   POST /v1/guests/:id    {wallet, deadline, signature}   bind the wallet, fund the escrow
 *   POST /v1/sessions      {agentId, wallet}               start a negotiation
 *   GET  /v1/sessions/:id                  status and what the desk is waiting for
 *   POST /v1/sessions/:id/:kind  {round?, ...}             answer it: consent, commit, reveal, authorize
 *   GET  /v1/stats                         what guests did here, with transactions
 */
export function deskApp(desk: Desk, trustedProxy = "loopback") {
  const limits = limiter();
  const app = express();
  // Behind one reverse proxy: take the client address it forwards, from that proxy only.
  app.set("trust proxy", trustedProxy);
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    res.set("access-control-allow-origin", "*");
    res.set("access-control-allow-headers", "content-type");
    res.set("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    try {
      limits.request(req.ip ?? "unknown");
      next();
    } catch (error) {
      fail(res, error);
    }
  });

  const route = (run: (req: Request) => unknown) => async (req: Request, res: Response) => {
    try {
      res.json(await run(req));
    } catch (error) {
      fail(res, error);
    }
  };
  const str = (v: unknown, what: string) => {
    if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new DeskError(400, `${what}: expected a string`);
    return v;
  };

  app.get("/v1/desk", route(() => desk.info()));
  app.get("/v1/stats", route(() => desk.stats()));
  app.post(
    "/v1/guests",
    route((req) => {
      limits.guest(req.ip ?? "unknown");
      return desk.startGuest(str(req.body?.wallet, "wallet"));
    }),
  );
  app.post(
    "/v1/guests/:agentId",
    route((req) =>
      desk.finishGuest(String(req.params.agentId), str(req.body?.wallet, "wallet"), str(req.body?.deadline, "deadline"), str(req.body?.signature, "signature")),
    ),
  );
  app.post("/v1/sessions", route((req) => desk.openSession(str(String(req.body?.agentId ?? ""), "agentId"), str(req.body?.wallet, "wallet"))));
  app.get("/v1/sessions/:id", route((req) => desk.session(String(req.params.id))));
  app.post(
    "/v1/sessions/:id/:kind",
    route((req) => {
      const kind = String(req.params.kind) as (typeof KINDS)[number];
      if (!KINDS.includes(kind)) throw new DeskError(404, `no such step: ${kind}`);
      const round = req.body?.round === undefined ? undefined : Number(req.body.round);
      return desk.answer(String(req.params.id), kind, round, req.body ?? {});
    }),
  );
  app.use((_req, res) => void res.status(404).json({ error: "not found" }));
  return app;
}

function fail(res: Response, error: unknown) {
  const status = error instanceof DeskError ? error.status : 500;
  // Chain and RPC errors can be long; the first line says enough.
  const message = (error as { shortMessage?: string })?.shortMessage ?? (error instanceof Error ? error.message : String(error));
  res.status(status).json({ error: message.split("\n")[0].slice(0, 300) });
}
