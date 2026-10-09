import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { commitmentHash, domainSeparator } from "../../../../agents/sealed/commitment";
import { SealedReader } from "../read";
import { protocolGuide } from "./protocol";

declare const __SEALED_VERSION__: string;

const uint = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/, "a non-negative integer")]);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a 20-byte hex address");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "32 bytes of hex");
const policy = z
  .object({
    reviewers: z.array(address).min(1).describe("Reviewers whose ERC-8004 feedback counts"),
    minFeedbackCount: uint,
    minAverageValue: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).describe("In `decimals` fixed point: 400 with decimals 2 is 4.00"),
    decimals: z.number().int().min(0).max(18),
    tag1: z.string().default(""),
  })
  .describe("Admission policy. Defaults to the demo policy the Sealed negotiations were opened under.");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// JSON has no bigint: every bigint leaves as a decimal string.
const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }],
});

const guarded =
  <A>(run: (args: A) => Promise<unknown> | unknown) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return json(await run(args));
    } catch (error) {
      const message = (error as { shortMessage?: string })?.shortMessage ?? (error instanceof Error ? error.message : String(error));
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };

/** The Sealed MCP server: read-only, keyless. Connect it to any transport. */
export function createSealedMcpServer(reader: SealedReader, rpcUrl: string): McpServer {
  const d = reader.deployment;
  const server = new McpServer({ name: "sealed", version: __SEALED_VERSION__ });
  // Only the origin: a provider URL often carries an API key in its path or query.
  const guide = protocolGuide(d, URL.canParse(rpcUrl) ? new URL(rpcUrl).origin : "custom");

  server.registerResource(
    "protocol",
    "sealed://protocol",
    { title: "Sealed protocol and addresses", description: `How Sealed works and its contracts on ${d.name}`, mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide }] }),
  );

  server.registerTool(
    "describe_protocol",
    { title: "Describe Sealed", description: `How a Sealed negotiation works, and the contract addresses on ${d.name}.`, annotations: { readOnlyHint: true, openWorldHint: false } },
    async () => ({ content: [{ type: "text", text: guide }] }),
  );

  server.registerTool(
    "get_negotiation",
    {
      title: "Get a negotiation",
      description: "Reads a Sealed negotiation: status (None, Open, Locked, Settled, Expired), both parties' wallets and ERC-8004 agent ids, current commitments and commit indices, deadline and settled price. Offers are never stored, so none appear.",
      inputSchema: { negotiationId: uint.describe("Negotiation id, e.g. 4") },
      annotations: READ,
    },
    guarded(async ({ negotiationId }) => {
      const n = await reader.getNegotiation(BigInt(negotiationId));
      return { ...n, deadlineIso: n.deadline ? new Date(Number(n.deadline) * 1000).toISOString() : null, nextCommitIndex: { buyer: n.buyerCommitIndex + 1, seller: n.sellerCommitIndex + 1 } };
    }),
  );

  server.registerTool(
    "check_admission",
    {
      title: "Check admission",
      description: "Whether an ERC-8004 agent would be admitted to a Sealed negotiation: its wallet must be the one the Identity Registry has on record, and it must clear the policy in ReputationGate.",
      inputSchema: {
        agentId: uint.describe("ERC-8004 agent id, e.g. 2084"),
        wallet: address.optional().describe("Wallet to check. Defaults to the agent's registered wallet."),
        policy: policy.optional(),
      },
      annotations: READ,
    },
    guarded(async ({ agentId, wallet, policy: p }) =>
      reader.checkAdmission(BigInt(agentId), {
        wallet,
        policy: p && { ...p, minFeedbackCount: BigInt(p.minFeedbackCount), minAverageValue: BigInt(p.minAverageValue) },
      }),
    ),
  );

  server.registerTool(
    "read_reputation",
    {
      title: "Read ERC-8004 reputation",
      description: "ERC-8004 getSummary for an agent, counting only the given reviewers (the demo policy's trusted reviewers by default): number of non-revoked reviews and their average.",
      inputSchema: {
        agentId: uint.describe("ERC-8004 agent id"),
        reviewers: z.array(address).min(1).optional(),
        tag1: z.string().optional(),
        tag2: z.string().optional(),
      },
      annotations: READ,
    },
    guarded(({ agentId, reviewers, tag1, tag2 }) => reader.readReputation(BigInt(agentId), { reviewers, tag1, tag2 })),
  );

  server.registerTool(
    "compute_commitment",
    {
      title: "Compute a commitment",
      description: "Computes a Sealed commitment locally, exactly as the contract does: keccak256(domainSeparator, negotiationId, party, commitIndex, offer, salt). Makes no network call. Use it to check a published reveal; a live salt is a secret and belongs only to its agent.",
      inputSchema: {
        negotiationId: uint,
        party: address.describe("The committing party's wallet"),
        commitIndex: z.number().int().min(1).max(4294967295).describe("1 for a party's first commit, then 2, 3, ..."),
        offer: uint.describe("The offer, in the negotiation's unit"),
        salt: bytes32,
        chainId: z.number().int().positive().optional().describe(`Defaults to ${d.chainId}`),
        verifyingContract: address.optional().describe(`Defaults to SealedNegotiation at ${d.sealedNegotiation}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(({ negotiationId, party, commitIndex, offer, salt, chainId, verifyingContract }) => {
      const domain = { chainId: chainId ?? d.chainId, verifyingContract: verifyingContract ?? d.sealedNegotiation };
      return {
        commitment: commitmentHash({ domain, negotiationId: BigInt(negotiationId), party, commitIndex, position: { offer: BigInt(offer), salt } }),
        domainSeparator: domainSeparator(domain),
        domain,
      };
    }),
  );

  server.registerTool(
    "verify_settlement",
    {
      title: "Verify a settlement",
      description: "Checks a Sealed settle transaction against the chain alone: decodes the disclosed offers and salts, recomputes both commitments and compares them with the stored ones and with the commit transactions that put them on-chain, recovers both EIP-712 signers, and checks the NegotiationSettled event and stored price against the midpoint. Returns every check with pass or fail.",
      inputSchema: {
        txHash: bytes32.describe("Hash of the settle transaction"),
        lookbackBlocks: z.number().int().min(100).max(50000).optional().describe("How far before the settlement to search for the final commits. Default 3000."),
      },
      annotations: READ,
    },
    guarded(({ txHash, lookbackBlocks }) => reader.verifySettlement(txHash, { lookbackBlocks })),
  );

  return server;
}
