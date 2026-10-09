import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MONAD_TESTNET } from "../addresses";
import { SealedReader } from "../read";
import { createSealedMcpServer } from "./server";

/**
 * sealed-mcp: the Sealed MCP server over stdio. Read-only, no keys.
 * RPC: SEALED_RPC_URL, else MONAD_RPC_URL, else Monad's public testnet RPC.
 * stdout carries the protocol, so diagnostics go to stderr only.
 */
async function main() {
  const rpcUrl = process.env.SEALED_RPC_URL || process.env.MONAD_RPC_URL || MONAD_TESTNET.rpcUrl;
  const reader = new SealedReader({ rpcUrl });
  const server = createSealedMcpServer(reader, rpcUrl);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("sealed-mcp failed to start:", error);
  process.exit(1);
});
