import fs from "fs";
import { network } from "hardhat";
import { PrivyClient } from "@privy-io/node";
import { TRANSACTION_METHODS, reputationRule } from "../agents/privy/mandate";
import { REGISTRIES } from "./registries";

/**
 * Adds the ERC-8004 `giveFeedback` rule to the mandate policy that
 * scripts/privy-demo.ts already created, so its wallets can rate the
 * counterparty of a settled deal. The policy is changed in place, with the
 * authorization key of the quorum that owns it; nothing else in it changes.
 * Rules already present are left alone, so a re-run does nothing.
 *
 *   npx hardhat run scripts/privy-feedback-rule.ts --network monadTestnet
 */

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env. See .env.example.`);
  return value;
}

async function main() {
  const privy = new PrivyClient({ appId: env("PRIVY_APP_ID"), appSecret: env("PRIVY_APP_SECRET") });
  const authorization_context = { authorization_private_keys: [env("PRIVY_AUTHORIZATION_KEY")] };
  const state = JSON.parse(fs.readFileSync(`deployments/privy-${network.name}.json`, "utf8"));
  const chainId = Number(JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8")).chainId);
  const reputation = REGISTRIES[chainId].reputation;

  const policy = await privy.policies().get(state.policyId);
  const present = new Set(policy.rules.map((r) => r.name));
  for (const method of TRANSACTION_METHODS) {
    const rule = reputationRule(reputation, chainId, method);
    if (present.has(rule.name)) {
      console.log(`already there: ${rule.name}`);
      continue;
    }
    const created = await privy.policies().createRule(state.policyId, { ...rule, authorization_context } as any);
    console.log(`added: ${rule.name} · ${created.id}`);
  }
  const after = await privy.policies().get(state.policyId);
  console.log(`policy ${state.policyId} now has ${after.rules.length} rules:`);
  for (const r of after.rules) console.log(`  ${r.method}  ${r.name}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
