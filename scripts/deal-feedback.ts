import fs from "fs";
import { ethers, network } from "hardhat";
import { Wallet } from "ethers";
import { PrivyClient } from "@privy-io/node";
import { AgentWallet } from "../agents/privy/agentWallet";
import { LocalPartyWallet, type PartyWallet } from "../agents/wallets/partyWallet";
import { feedbackFor, readSettlement } from "../agents/sealed/dealFeedback";
import { REGISTRIES } from "./registries";

/**
 * Has both agents of a settled demo run rate each other in ERC-8004, pointing
 * the feedback at the settlement (agents/sealed/dealFeedback.ts). Runs made
 * since this existed do it on their own right after settling; this script
 * does the same for runs that settled before, and says so in the transcript.
 *
 *   RUN=demo-runs/monadTestnet-deal-4.json npx hardhat run scripts/deal-feedback.ts --network monadTestnet
 *
 * Each agent signs with the same wallet it negotiated with: the demo keys for
 * local runs, the Privy wallets (under the mandate) for Privy runs.
 */

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}.`);
  return value;
}

async function main() {
  const file = env("RUN");
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  if (run.outcome !== "settled" || !run.settleTx) throw new Error(`${file} did not settle; there is no deal to rate.`);
  const chainId = Number(run.chainId);
  const domain = { chainId: BigInt(chainId), verifyingContract: run.contract as string };
  const reputation = REGISTRIES[chainId].reputation;

  const wallets = {} as Record<"buyer" | "seller", PartyWallet>;
  if (String(run.wallets ?? "").includes("Privy")) {
    const privy = new PrivyClient({ appId: env("PRIVY_APP_ID"), appSecret: env("PRIVY_APP_SECRET") });
    const state = JSON.parse(fs.readFileSync(`deployments/privy-${network.name}.json`, "utf8"));
    for (const role of ["buyer", "seller"] as const) {
      const w = state.wallets[role];
      wallets[role] = new AgentWallet({ privy, walletId: w.walletId, address: w.address, domain, authorizationPrivateKey: env("PRIVY_AUTHORIZATION_KEY"), provider: ethers.provider });
    }
  } else {
    const keys = JSON.parse(fs.readFileSync(".demo-wallets.json", "utf8"));
    for (const role of ["buyer", "seller"] as const) wallets[role] = new LocalPartyWallet(new Wallet(keys[role], ethers.provider), domain);
  }

  const deal = await readSettlement(ethers.provider, domain.verifyingContract, run.settleTx);
  run.feedback ??= {};
  for (const role of ["buyer", "seller"] as const) {
    if (wallets[role].address.toLowerCase() !== run.agents[role].wallet.toLowerCase()) {
      throw new Error(`${role}: the wallet at hand is not the one that negotiated ${file}`);
    }
    if (run.feedback[role]) {
      console.log(`${role} already rated: ${run.feedback[role]}`);
      continue;
    }
    run.feedback[role] = await wallets[role].giveFeedback!(reputation, feedbackFor(deal, wallets[role].address, run.settleTx, chainId));
    run.feedbackNote = "Given after the run by scripts/deal-feedback.ts; runs since then rate right after settling.";
    fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
    console.log(`${role} rated agent ${role === "buyer" ? deal.sellerAgentId : deal.buyerAgentId}: ${run.feedback[role]}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
