import { JsonRpcProvider, Wallet } from "ethers";
import { DeskClient } from "../agents/desk/client";

/**
 * A guest at the Sealed desk in a few lines: a fresh key with no MON, a limit
 * that never leaves this process, and one offer per round. The same client
 * backs the MCP desk tools in packages/sealed.
 *
 *   DESK_URL=https://... npx tsx scripts/desk-guest.ts 4300 4000 4150 4250
 *   (limit, then one offer per round)
 */
async function main() {
  const [limit, ...offers] = process.argv.slice(2).map(BigInt);
  if (!limit || offers.length === 0) throw new Error("usage: desk-guest.ts <limit> <offer round 1> [<offer round 2> ...]");
  const client = new DeskClient({
    url: process.env.DESK_URL ?? "http://127.0.0.1:8787",
    key: Wallet.createRandom(),
    provider: new JsonRpcProvider(process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz"),
  });
  const info = await client.describe();
  console.log(`desk: ${info.terms}; seller lists at ${info.seller.listPrice}; contract ${info.contracts.sealedNegotiation}`);
  console.log(`guest wallet ${client.address} (no MON)`);

  const { agentId, transactions } = await client.join();
  console.log(`guest identity: ERC-8004 agent ${agentId}`, transactions);
  const opened = await client.open(agentId, limit);
  console.log(`negotiation ${opened.negotiationId} opened, deadline ${opened.deadline}`);

  for (const offer of offers) {
    const result = await client.offer(offer);
    console.log(JSON.stringify(result));
    if (result.crossed || result.roundsLeft === 0) break;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
