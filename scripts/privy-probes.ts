import fs from "fs";
import { ethers, network } from "hardhat";
import { Wallet } from "ethers";
import { PrivyClient } from "@privy-io/node";
import { AgentWallet } from "../agents/privy/agentWallet";
import { mandateProbes, probesHold, runMandateProbes } from "../agents/privy/probes";
import { REGISTRIES } from "./registries";

/**
 * Sends the mandate probes (agents/privy/probes.ts) to the buyer's Privy wallet
 * and records the results in deployments/privy-<network>.json, without running
 * another negotiation. Probes already recorded are not sent again.
 *
 *   npx hardhat run scripts/privy-probes.ts --network monadTestnet
 */

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env. See .env.example.`);
  return value;
}

async function main() {
  const privy = new PrivyClient({ appId: env("PRIVY_APP_ID"), appSecret: env("PRIVY_APP_SECRET") });
  const authorizationPrivateKey = env("PRIVY_AUTHORIZATION_KEY");
  const relayer = new Wallet(env("DEPLOYER_PRIVATE_KEY"), ethers.provider);
  const deployment = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const chainId = Number(deployment.chainId);
  const domain = { chainId: BigInt(chainId), verifyingContract: deployment.contracts.SealedNegotiation as string };

  const stateFile = `deployments/privy-${network.name}.json`;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const buyer = state.wallets.buyer;
  if (!buyer || !state.negotiations?.length) throw new Error("Run scripts/privy-demo.ts first: the probes need its wallets and a negotiation.");

  const probes = mandateProbes({
    privy,
    walletId: buyer.walletId,
    authorizationPrivateKey,
    chainId,
    sealed: domain.verifyingContract,
    identityRegistry: REGISTRIES[chainId].identity,
    reputationRegistry: REGISTRIES[chainId].reputation,
    outsider: relayer.address,
    agentWallet: new AgentWallet({ privy, walletId: buyer.walletId, address: buyer.address, domain, authorizationPrivateKey, provider: ethers.provider }),
    negotiationId: BigInt(state.negotiations.at(-1)),
  });
  const { records, inconclusive } = await runMandateProbes(probes, state.mandateProbes ?? [], (next) => {
    state.mandateProbes = next;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  });

  for (const probe of records) console.log(`${probe.refused ? "refused" : "signed "}  ${probe.label}`);
  for (const probe of inconclusive) console.log(`INCONCLUSIVE (not recorded)  ${probe.attempted} · ${probe.error}`);
  const refused = records.filter((r) => r.refused).length;
  console.log(`\n${refused} refused, ${records.length - refused} signed, ${inconclusive.length} inconclusive`);
  if (!probesHold(probes, records, inconclusive)) throw new Error("A probe was inconclusive or did not end as the mandate says; nothing here proves the mandate.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
