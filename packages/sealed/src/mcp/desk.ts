import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { JsonRpcProvider, Wallet } from "ethers";
import { z } from "zod";
import { DeskClient } from "../../../../agents/desk/client";
import { MONAD_TESTNET_V3 } from "../addresses";

/** Where the guest key and identity live. One fresh testnet key per machine, never funded. */
const home = () => process.env.SEALED_HOME || path.join(os.homedir(), ".sealed");

function guestKey(): Wallet {
  if (process.env.SEALED_GUEST_KEY) return new Wallet(process.env.SEALED_GUEST_KEY);
  const file = path.join(home(), "guest-key.json");
  if (fs.existsSync(file)) return new Wallet(JSON.parse(fs.readFileSync(file, "utf8")).privateKey);
  const key = Wallet.createRandom();
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify({ note: "Sealed desk guest key, Monad testnet only. Generated on this machine; never funded.", address: key.address, privateKey: key.privateKey }, null, 2),
    { mode: 0o600 },
  );
  return new Wallet(key.privateKey);
}

const identityFile = () => path.join(home(), "guest-identity.json");
const loadIdentity = (deskUrl: string): string | undefined => {
  if (!fs.existsSync(identityFile())) return undefined;
  const saved = JSON.parse(fs.readFileSync(identityFile(), "utf8"));
  return saved.deskUrl === deskUrl ? saved.agentId : undefined;
};

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
const guarded =
  <A>(run: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return json(await run(args));
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  };
const uint = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);

/**
 * Tools to negotiate at the Sealed desk from any MCP client. The desk pays all
 * gas; this server holds the guest key and the buyer's limit, and checks every
 * request from the desk before signing anything.
 */
export function registerDeskTools(server: McpServer, rpcUrl: string, deskUrl: string) {
  let client: DeskClient | undefined;
  const get = () =>
    (client ??= new DeskClient({ url: deskUrl, key: guestKey(), provider: new JsonRpcProvider(rpcUrl), expectedContract: MONAD_TESTNET_V3.sealedNegotiation }));

  const ensureIdentity = async () => {
    const c = get();
    const saved = loadIdentity(deskUrl);
    if (saved) return { agentId: saved, created: false as const };
    const joined = await c.join();
    fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(identityFile(), JSON.stringify({ deskUrl, wallet: c.address, ...joined }, null, 2));
    return { agentId: joined.agentId, created: true as const, transactions: joined.transactions };
  };

  server.registerTool(
    "desk_info",
    {
      title: "Sealed desk: what is for sale",
      description:
        "Reads the Sealed desk: a public counter where any agent can negotiate a paid deal for API access against the desk's seller on Monad testnet, without MON. Returns the terms, unit, payment rule, the seller's list price and concession rule, the contract, and the trust model. Start here.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => ({ desk: deskUrl, guestWallet: get().address, ...(await get().describe()) })),
  );

  server.registerTool(
    "desk_open_negotiation",
    {
      title: "Sealed desk: open a negotiation",
      description:
        "Opens a paid sealed-offer negotiation at the desk as the buyer. `limit` is the most your principal pays, in the desk's unit (US cents per 1,000 API calls): it stays on this machine and every offer is checked against it, it is never sent. On first use, the desk registers an ERC-8004 identity for this machine's guest wallet and funds its escrow with test dollars; you sign, it pays the gas. This tool checks the terms against the desk's listing and signs them. Then call desk_submit_offer once per round.",
      inputSchema: { limit: uint.describe("Most your principal pays, e.g. 4300 for $43.00 per 1,000 calls") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async ({ limit }) => {
      const identity = await ensureIdentity();
      const opened = await get().open(identity.agentId, BigInt(limit));
      return {
        ...opened,
        agentId: identity.agentId,
        identityCreated: identity.created,
        next: "Call desk_submit_offer with your round 1 offer. Each round both sides commit a sealed number; if yours is at or above the seller's, the deal settles at the midpoint and is paid on-chain. Otherwise you learn only that the round did not cross.",
      };
    }),
  );

  server.registerTool(
    "desk_submit_offer",
    {
      title: "Sealed desk: play one round",
      description:
        "Plays one round with a sealed offer. Signs a salted commitment of the offer, waits until both sides' commitments are on-chain (read from the chain, not from the desk), reveals it to the desk's relay, checks and signs the settlement authorization, and returns whether the round crossed. If it crossed, the negotiation settled at the midpoint of the two offers and the price was paid from the escrow: the result has the price, the amount, the fee and the transactions. Offers above your limit, or below your previous offer, are refused before anything is signed.",
      inputSchema: {
        offer: uint.describe("This round's offer, in the desk's unit"),
        stance: z.enum(["open-with-room", "concede", "hold", "final-at-limit"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async ({ offer, stance }) => get().offer(BigInt(offer), stance)),
  );

  server.registerTool(
    "desk_status",
    {
      title: "Sealed desk: negotiation status",
      description: "The status of the negotiation opened from this session: rounds played and whether each crossed, outcome, settled price, amount paid, fee and transactions.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => ({ ...get().current, ...(await get().status()) })),
  );
}
