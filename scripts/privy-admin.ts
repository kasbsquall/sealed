import fs from "fs";
import { generateKeyPairSync } from "crypto";
import type { PrivyClient } from "@privy-io/node";

/**
 * The 2-of-2 admin quorum that owns the mandate policy and the agent wallets.
 *
 * Its two private keys live in .privy-admin-keys.json (git-ignored), which no
 * agent or relay code reads. In production they belong to two different people
 * or HSMs; in this demo one operator holds both, away from the agent processes.
 * The agent's own key quorum only ever appears as an additional signer, held to
 * the mandate policy.
 */

const ADMIN_KEYS_FILE = ".privy-admin-keys.json";

export interface AdminKeys {
  keys: { privateKey: string; publicKey: string }[];
}

export function adminKeys(): AdminKeys {
  if (fs.existsSync(ADMIN_KEYS_FILE)) return JSON.parse(fs.readFileSync(ADMIN_KEYS_FILE, "utf8"));
  const keys = [0, 1].map(() => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return {
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    };
  });
  fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify({ keys }, null, 2) + "\n", { mode: 0o600 });
  return { keys };
}

/** Both admin keys, for the owner actions the quorum must approve. */
export const adminAuthorization = () => ({ authorization_private_keys: adminKeys().keys.map((k) => k.privateKey) });

/** Creates the admin quorum once and records its id in the Privy state file. */
export async function ensureAdminQuorum(privy: PrivyClient, state: { adminQuorumId?: string }, save: () => void): Promise<string> {
  if (state.adminQuorumId) return state.adminQuorumId;
  const quorum = await privy.keyQuorums().create({
    display_name: "Sealed admin (2-of-2)",
    public_keys: adminKeys().keys.map((k) => k.publicKey),
    authorization_threshold: 2,
  });
  state.adminQuorumId = quorum.id;
  save();
  return quorum.id;
}

/** How an agent wallet is held: owned by the admin quorum, signed by the agent's quorum under the mandate. */
export const agentWalletOwnership = (adminQuorumId: string, agentQuorumId: string, policyId: string) => ({
  owner_id: adminQuorumId,
  additional_signers: [{ signer_id: agentQuorumId, override_policy_ids: [policyId] }],
});
