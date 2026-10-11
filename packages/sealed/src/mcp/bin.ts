import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MONAD_TESTNET, SEALED_DESK_URL } from "../addresses";
import { SealedReader } from "../read";
import { createSealedMcpServer } from "./server";

/**
 * sealed-mcp: the Sealed MCP server over stdio. The read tools need no key;
 * the desk tools create a local testnet guest key in ~/.sealed on first use.
 * RPC: SEALED_RPC_URL, else MONAD_RPC_URL, else Monad's public testnet RPC.
 * stdout carries the protocol, so diagnostics go to stderr only.
 */
async function main() {
  const rpcUrl = process.env.SEALED_RPC_URL || process.env.MONAD_RPC_URL || MONAD_TESTNET.rpcUrl;
  const reader = new SealedReader({ rpcUrl });
  // SEALED_DESK_URL=off leaves the server read-only and keyless.
  const desk = process.env.SEALED_DESK_URL || SEALED_DESK_URL;
  const server = createSealedMcpServer(reader, rpcUrl, desk && desk !== "off" ? desk : undefined);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("sealed-mcp failed to start:", error);
  process.exit(1);
});
