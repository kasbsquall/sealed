import "dotenv/config";
import fs from "fs";
import { PrivyClient } from "@privy-io/node";

/** Read-only: prints who owns the Privy mandate policy and the agent wallets. */
async function main() {
  const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET! });
  const state = JSON.parse(fs.readFileSync("deployments/privy-monadTestnet.json", "utf8"));
  const policy: any = await privy.policies().get(state.policyId);
  console.log("policy", state.policyId, "owner_id", policy.owner_id, "rules", policy.rules.length);
  for (const [role, w] of Object.entries<any>(state.wallets)) {
    const wallet: any = await privy.wallets().get(w.walletId);
    console.log(role, "owner_id", wallet.owner_id, "policy_ids", wallet.policy_ids, "additional_signers", JSON.stringify(wallet.additional_signers));
  }
  const quorum: any = await privy.keyQuorums().get(process.env.PRIVY_KEY_QUORUM_ID!);
  console.log("quorum", quorum.id, "threshold", quorum.authorization_threshold, "keys", quorum.authorization_keys?.length, "users", quorum.user_ids?.length ?? 0);
}
main().catch((e) => { console.error(e?.status, e?.message); process.exitCode = 1; });
