// Smoke test: starts the built sealed-mcp binary over stdio, as Claude Desktop
// or Claude Code would, lists its tools and calls the offline ones.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = fileURLToPath(new URL("../dist/mcp.mjs", import.meta.url));
const run4 = JSON.parse(readFileSync(new URL("../../../demo-runs/monadTestnet-deal-4.json", import.meta.url), "utf8"));
const client = new Client({ name: "sealed-smoke", version: "0.0.0" });
const text = (result) => result.content.map((c) => c.text).join("");

before(async () => {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], stderr: "pipe" }));
});
after(() => client.close());

test("lists the read-only tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["check_admission", "compute_commitment", "describe_protocol", "get_negotiation", "read_reputation", "verify_settlement"],
  );
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
});

test("compute_commitment reproduces the buyer's final commitment in negotiation #4", async () => {
  const last = run4.rounds.at(-1).buyer;
  const result = await client.callTool({
    name: "compute_commitment",
    arguments: { negotiationId: 4, party: run4.agents.buyer.wallet, commitIndex: last.commitIndex, offer: last.offer, salt: last.salt },
  });
  assert.ok(!result.isError, text(result));
  assert.equal(JSON.parse(text(result)).commitment, last.commitment);
});

test("rejects malformed input instead of guessing", async () => {
  const result = await client.callTool({
    name: "compute_commitment",
    arguments: { negotiationId: 4, party: "0x1234", commitIndex: 1, offer: 1, salt: "0x00" },
  });
  assert.equal(result.isError, true);
});

test("serves the protocol guide with the addresses", async () => {
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri), ["sealed://protocol"]);
  const { contents } = await client.readResource({ uri: "sealed://protocol" });
  assert.match(contents[0].text, /0xAdBd2619c8f51873B6dB131843cce3403E0869dD/);
  assert.match(contents[0].text, /0x8004B663056A597Dffe9eCcC1965A193B7388713/);
});
