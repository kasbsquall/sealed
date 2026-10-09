import fs from "fs";
import { network } from "hardhat";
import { PrivyClient } from "@privy-io/node";
import { buildMandateRules } from "../agents/privy/mandate";
import { adminAuthorization } from "./privy-admin";

/**
 * Extends the live mandate policy to the current SealedNegotiation contract.
 * The policy was written for the first deployment; this adds, for the address
 * in deployments/<network>.json, the same three Sealed rules the mandate
 * already has for the first one (transactions with zero value by send and by
 * sign-only, and EIP-712 payloads whose domain is that contract on that chain).
 * It signs with the 2-of-2 admin quorum that owns the policy; the agent's key
 * cannot do this. Rules already present are left alone, so a re-run does nothing.
 *
 *   npx hardhat run scripts/privy-contract-rule.ts --network monadTestnet
 */

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env. See .env.example.`);
  return value;
}

async function main() {
  const privy = new PrivyClient({ appId: env("PRIVY_APP_ID"), appSecret: env("PRIVY_APP_SECRET") });
  const authorization_context = adminAuthorization();
  const stateFile = `deployments/privy-${network.name}.json`;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const deployment = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const sealedAddress: string = deployment.contracts.SealedNegotiation;
  const tag = sealedAddress.slice(0, 10).toLowerCase();

  // Only the Sealed rules: no registries, so register and giveFeedback are not duplicated.
  const rules = buildMandateRules({ sealedAddress, chainId: Number(deployment.chainId) }).map((rule) => ({
    ...rule,
    // Privy rejects rule names of 50 characters or more.
    name: rule.method === "eth_signTypedData_v4" ? `Sealed ${tag} EIP-712 only` : `Sealed ${tag} only (${rule.method})`,
  }));

  const policy = await privy.policies().get(state.policyId);
  const present = new Set(policy.rules.map((r) => r.name));
  for (const rule of rules) {
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

  const contracts: string[] = state.mandateContracts ?? (deployment.contractsV1 ? [deployment.contractsV1.SealedNegotiation] : []);
  if (!contracts.includes(sealedAddress)) contracts.push(sealedAddress);
  state.mandateContracts = contracts;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
