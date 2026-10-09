// Live check against Monad testnet, through the MCP server over stdio:
// verify_settlement on the settlement of negotiation #4 must pass every check,
// and get_negotiation(4) must report Settled at 4190. Needs network, no keys.
//   npm run live            (SEALED_RPC_URL overrides the public RPC)
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SETTLE_TX = "0xb4f7adf14c5253ce89e16dd33f7d81365819262e6510148b4dbeb70fd88ce498";
const bin = fileURLToPath(new URL("../dist/mcp.mjs", import.meta.url));
const client = new Client({ name: "sealed-live-check", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin] }));

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text).join("");
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
};

let failures = 0;
const report = await call("verify_settlement", { txHash: SETTLE_TX });
console.log(`verify_settlement ${SETTLE_TX}`);
for (const c of report.checks) {
  console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.label}`);
  if (!c.ok) failures++;
}
if (!report.ok) failures++;

const n = await call("get_negotiation", { negotiationId: 4 });
console.log(`\nget_negotiation 4: ${n.status}, price ${n.settledPrice}, commits buyer #${n.buyerCommitIndex} seller #${n.sellerCommitIndex}, agents ${n.buyerAgentId}/${n.sellerAgentId}`);
if (n.status !== "Settled" || n.settledPrice !== "4190") failures++;

const admission = await call("check_admission", { agentId: 2084 });
console.log(`check_admission 2084: admitted ${admission.admitted} (wallet ${admission.wallet}, clears ${admission.clears})`);
const reputation = await call("read_reputation", { agentId: 2084 });
console.log(`read_reputation 2084: ${reputation.count} reviews from the trusted reviewers, average ${reputation.averageText}`);

await client.close();
console.log(failures ? `\n${failures} failure(s).` : "\nEvery check passed.");
process.exitCode = failures ? 1 : 0;
