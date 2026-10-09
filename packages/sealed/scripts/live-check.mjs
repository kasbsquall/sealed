// Live check against Monad testnet, through the MCP server over stdio. Needs
// network, no keys. verify_settlement must pass every check on the v1
// settlement of negotiation #4 and, when one is given, on a v2 settlement;
// get_negotiation(4) on v1 must report Settled at 4190.
//   npm run live                      (v1 settlement, v2 reads)
//   npm run live -- <v2 settle tx>    (also verifies a v2 settlement)
// SEALED_RPC_URL overrides the public RPC.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const V1_SETTLE_TX = "0xb4f7adf14c5253ce89e16dd33f7d81365819262e6510148b4dbeb70fd88ce498";
const v2SettleTx = process.argv[2];
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
for (const txHash of [V1_SETTLE_TX, v2SettleTx].filter(Boolean)) {
  const report = await call("verify_settlement", { txHash });
  console.log(`verify_settlement ${txHash} (v${report.contractVersion}, negotiation #${report.negotiationId} at ${report.contract})`);
  for (const c of report.checks) {
    console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.label}`);
    if (!c.ok) failures++;
  }
  if (!report.ok) failures++;
  console.log("");
}

const n4 = await call("get_negotiation", { negotiationId: 4, deployment: "v1" });
console.log(`get_negotiation 4 (v1 ${n4.contract}): ${n4.status}, price ${n4.settledPrice}, commits buyer #${n4.buyerCommitIndex} seller #${n4.sellerCommitIndex}, agents ${n4.buyerAgentId}/${n4.sellerAgentId}, layout v${n4.layout}`);
if (n4.status !== "Settled" || n4.settledPrice !== "4190" || n4.layout !== 1) failures++;

const v2 = await call("get_negotiation", { negotiationId: 1 });
console.log(`get_negotiation 1 (v2 ${v2.contract}): ${v2.status}, layout v${v2.layout}, policyHash ${v2.policyHash}`);
if (v2.layout !== 2) failures++;

for (const deployment of ["v2", "v1"]) {
  const a = await call("check_admission", { agentId: 2084, deployment });
  console.log(`check_admission 2084 on ${deployment}: admitted ${a.admitted} (wallet ${a.wallet}, clears ${a.clears}, policyHash ${a.policyHash})`);
  if (!a.admitted) failures++;
}
const refused = await call("check_admission", { agentId: 2086 });
console.log(`check_admission 2086 on v2: admitted ${refused.admitted} (clears ${refused.clears})`);
if (refused.admitted) failures++;
const reputation = await call("read_reputation", { agentId: 2084 });
console.log(`read_reputation 2084: ${reputation.count} reviews from the trusted reviewers, average ${reputation.averageText}`);

await client.close();
console.log(failures ? `\n${failures} failure(s).` : "\nEvery check passed.");
process.exitCode = failures ? 1 : 0;
