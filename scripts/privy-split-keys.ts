import fs from "fs";
import { ethers, network } from "hardhat";
import { Wallet } from "ethers";
import { PrivyClient } from "@privy-io/node";
import { AgentWallet } from "../agents/privy/agentWallet";
import { mandateProbes, runMandateProbes } from "../agents/privy/probes";
import { REGISTRIES } from "./registries";
import { adminAuthorization, adminKeys, agentWalletOwnership, ensureAdminQuorum } from "./privy-admin";

/**
 * Takes the mandate away from the agent's key.
 *
 * Before: one 1-of-1 key quorum owned the policy and both agent wallets, and the
 * agent signed with that same key, so a compromised agent process could rewrite
 * its own mandate or export its wallet. After: a 2-of-2 admin quorum, whose keys
 * no agent or relay code loads, owns the policy and the wallets; the agent's
 * quorum stays on each wallet only as an additional signer, held to the mandate
 * policy.
 *
 *   REHEARSE=1 npx hardhat run scripts/privy-split-keys.ts --network monadTestnet
 *     does it on a throwaway wallet first and checks every step, both ways.
 *   npx hardhat run scripts/privy-split-keys.ts --network monadTestnet
 *     does it on the live policy and the two agent wallets.
 *
 * A fresh setup does not need this: scripts/privy-demo.ts creates the policy and
 * the wallets this way from the start (scripts/privy-admin.ts).
 */

function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env. See .env.example.`);
  return value;
}

/** Owner-only actions attempted with the agent's key. Refused means Privy rejected the signature. */
async function attempt(label: string, run: () => Promise<unknown>): Promise<{ label: string; refused: boolean; response: string }> {
  try {
    await run();
    return { label, refused: false, response: "accepted" };
  } catch (error) {
    const e = error as { status?: number; message?: string };
    return { label, refused: true, response: `${e.status ?? "?"} ${String(e.message ?? error).slice(0, 300)}` };
  }
}

async function main() {
  const privy = new PrivyClient({ appId: env("PRIVY_APP_ID"), appSecret: env("PRIVY_APP_SECRET") });
  const agentKey = env("PRIVY_AUTHORIZATION_KEY");
  const agentQuorum = env("PRIVY_KEY_QUORUM_ID");
  const agentAuth = { authorization_private_keys: [agentKey] };
  const stateFile = `deployments/privy-${network.name}.json`;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const deployment = JSON.parse(fs.readFileSync(`deployments/${network.name}.json`, "utf8"));
  const chainId = Number(deployment.chainId);
  const domain = { chainId: BigInt(chainId), verifyingContract: deployment.contracts.SealedNegotiation as string };
  const relayer = new Wallet(env("DEPLOYER_PRIVATE_KEY"), ethers.provider);

  const adminAuth = adminAuthorization();
  const oneAdminAuth = { authorization_private_keys: [adminKeys().keys[0].privateKey] };
  const adminQuorum = await ensureAdminQuorum(privy, state, () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n"));
  const handOver = agentWalletOwnership(adminQuorum, agentQuorum, state.policyId);

  const checks = async (walletId: string, address: string) => {
    const agentWallet = new AgentWallet({ privy, walletId, address, domain, authorizationPrivateKey: agentKey, provider: ethers.provider });
    const probes = mandateProbes({
      privy, walletId, authorizationPrivateKey: agentKey, chainId, sealed: domain.verifyingContract,
      identityRegistry: REGISTRIES[chainId].identity, reputationRegistry: REGISTRIES[chainId].reputation,
      outsider: relayer.address, agentWallet, negotiationId: BigInt(state.negotiations.at(-1)),
    }).filter((p) => ["transfer", "personal-sign", "settle-authorization"].includes(p.id));
    const { records, inconclusive } = await runMandateProbes(probes, [], () => {});
    for (const r of records) console.log(`  signing  ${r.refused ? "refused" : "signed "}  ${r.label}`);
    for (const i of inconclusive) console.log(`  signing  INCONCLUSIVE  ${i.attempted} · ${i.error}`);
    return { records, inconclusive };
  };

  if (process.env.REHEARSE) {
    const wallet = await privy.wallets().create({ chain_type: "ethereum", owner_id: agentQuorum, policy_ids: [state.policyId], display_name: "Sealed key-split rehearsal" });
    console.log(`rehearsal wallet ${wallet.id}`);
    const before = await attempt("agent renames wallet (control, should pass)", () => privy.wallets().update(wallet.id, { display_name: "Sealed key-split rehearsal", authorization_context: agentAuth }));
    console.log(`  before   ${before.refused ? "refused" : "accepted"}  ${before.label} · ${before.response}`);
    await privy.wallets().update(wallet.id, { ...handOver, authorization_context: agentAuth });
    const after: any = await privy.wallets().get(wallet.id);
    console.log(`  owner now ${after.owner_id}, signers ${JSON.stringify(after.additional_signers)}`);
    await checks(wallet.id, wallet.address);
    for (const r of [
      await attempt("agent renames wallet", () => privy.wallets().update(wallet.id, { display_name: "agent was here", authorization_context: agentAuth })),
      await attempt("agent takes ownership back", () => privy.wallets().update(wallet.id, { owner_id: agentQuorum, authorization_context: agentAuth })),
      await attempt("agent exports the private key", () => privy.wallets().exportPrivateKey(wallet.id, { authorization_context: agentAuth } as any)),
      await attempt("one admin key alone renames wallet", () => privy.wallets().update(wallet.id, { display_name: "one admin", authorization_context: oneAdminAuth })),
      await attempt("both admin keys rename wallet (control, should pass)", () => privy.wallets().update(wallet.id, { display_name: "Sealed key-split rehearsal (admin)", authorization_context: adminAuth })),
    ]) console.log(`  owner    ${r.refused ? "refused " : "accepted"}  ${r.label} · ${r.response}`);
    return;
  }

  for (const [role, w] of Object.entries<any>(state.wallets)) {
    const current: any = await privy.wallets().get(w.walletId);
    if (current.owner_id !== adminQuorum) {
      await privy.wallets().update(w.walletId, { ...handOver, authorization_context: agentAuth });
      console.log(`${role} wallet handed to ${adminQuorum}`);
    }
  }
  const policy: any = await privy.policies().get(state.policyId);
  if (policy.owner_id !== adminQuorum) {
    await privy.policies().update(state.policyId, { owner_id: adminQuorum, authorization_context: agentAuth } as any);
    console.log(`policy ${state.policyId} handed to ${adminQuorum}`);
  }
  state.ownership = { admin: adminQuorum, adminThreshold: "2 of 2", agentSigner: agentQuorum, agentSignerPolicy: state.policyId };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  console.log("done; run scripts/privy-probes.ts to record what the agent key can no longer do");
}

main().catch((error) => {
  console.error(error?.status, error?.message ?? error);
  process.exitCode = 1;
});
