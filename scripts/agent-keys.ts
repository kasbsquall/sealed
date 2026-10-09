import fs from "fs";

/**
 * Writes each demo agent's key to its own file, .agent-keys/buyer.key and
 * .agent-keys/seller.key, so that in scripts/run-separated.ts an agent process
 * reads its own key and nothing else. Run once after the demo wallets exist:
 *   npm run keys:agents
 * The launcher never opens these files; it only passes each agent its path.
 */
const wallets = JSON.parse(fs.readFileSync(".demo-wallets.json", "utf8"));
fs.mkdirSync(".agent-keys", { recursive: true });
for (const role of ["buyer", "seller"] as const) {
  if (!wallets[role]) throw new Error(`.demo-wallets.json has no ${role} key`);
  fs.writeFileSync(`.agent-keys/${role}.key`, `${wallets[role]}\n`, { mode: 0o600 });
  console.log(`wrote .agent-keys/${role}.key`);
}
