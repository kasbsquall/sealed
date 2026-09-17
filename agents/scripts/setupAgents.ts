import { PrivyClient } from "@privy-io/node";
import { createSealedMandate } from "../privy/mandate";
import { provisionAgentWallet } from "../privy/agentWallet";

/**
 * One-time setup: create the mandate policy, then provision one wallet per
 * negotiator agent under it.
 *
 * Run once per deployment of SealedNegotiation. The wallet ids and addresses it
 * prints go into the agent configuration; the addresses are what you register
 * as `agentWallet` in the ERC-8004 Identity Registry.
 *
 *   npx tsx agents/scripts/setupAgents.ts 0xSealedAddress
 */
async function main() {
  const sealedAddress = process.argv[2];
  if (!sealedAddress) throw new Error("Usage: setupAgents.ts <SealedNegotiation address>");

  const required = ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_KEY_QUORUM_ID"];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing ${key}. See .env.example.`);
  }

  const privy = new PrivyClient({
    appId: process.env.PRIVY_APP_ID!,
    appSecret: process.env.PRIVY_APP_SECRET!,
  });

  const chainId = Number(process.env.MONAD_CHAIN_ID ?? 10143);
  const ownerId = process.env.PRIVY_KEY_QUORUM_ID!;

  const policy = await createSealedMandate(privy, { sealedAddress, chainId, ownerId });
  console.log(`Mandate policy   ${policy.id}`);
  console.log(`  bound to       ${sealedAddress} on chain ${chainId}`);

  for (const name of ["Sealed buyer agent", "Sealed seller agent"]) {
    const wallet = await provisionAgentWallet(privy, {
      ownerId,
      policyId: policy.id,
      displayName: name,
    });
    console.log(`${name.padEnd(20)} wallet ${wallet.id}  ${wallet.address}`);
  }

  console.log("\nRegister each address as the agentWallet of its ERC-8004 agent id.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
