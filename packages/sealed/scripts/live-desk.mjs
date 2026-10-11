// Live check of the desk tools, as an MCP client would use them: starts the
// built sealed-mcp over stdio with a fresh SEALED_HOME (so a new guest key with
// no MON), and negotiates a paid deal at the public desk on Monad testnet.
//   npm run build && node scripts/live-desk.mjs [limit] [offer ...]
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [limit = "4300", ...offers] = process.argv.slice(2);
const plan = offers.length ? offers : ["4000", "4150", "4250"];
const bin = fileURLToPath(new URL("../dist/mcp.mjs", import.meta.url));
const home = mkdtempSync(path.join(os.tmpdir(), "sealed-guest-"));
const client = new Client({ name: "sealed-live-desk", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], stderr: "inherit", env: { ...process.env, SEALED_HOME: home } }));

const call = async (name, args = {}) => {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60_000 });
  const text = result.content.map((c) => c.text).join("");
  console.log(`\n${name} ${JSON.stringify(args)} (${((Date.now() - started) / 1000).toFixed(1)} s)${result.isError ? " ERROR" : ""}\n${text.slice(0, 1200)}`);
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
};

try {
  const info = await call("desk_info");
  console.log(`guest home ${home}, wallet ${info.guestWallet}`);
  await call("desk_open_negotiation", { limit });
  for (const offer of plan) {
    const r = await call("desk_submit_offer", { offer });
    if (r.crossed || r.roundsLeft === 0) break;
  }
  await call("desk_status");
} finally {
  await client.close();
}
