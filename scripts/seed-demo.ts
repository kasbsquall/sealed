import fs from "fs";
import { ethers, network } from "hardhat";
import { Wallet, type ContractTransactionResponse } from "ethers";
import { REGISTRIES } from "./registries";
import { fees } from "./fees";

/**
 * Deploys Sealed and seeds the demo on a live network, against the canonical
 * ERC-8004 registries:
 *
 *   - deploys ReputationGate and SealedNegotiation,
 *   - creates local demo wallets (kept in .demo-wallets.json, never committed),
 *   - registers three agents in the ERC-8004 Identity Registry: a buyer, a
 *     seller, and a newcomer with almost no history,
 *   - has three demo reviewers leave feedback in the ERC-8004 Reputation
 *     Registry, so the buyer and seller clear the demo policy and the newcomer
 *     does not.
 *
 * All of this reputation is seeded by the demo itself and is labelled as such
 * in deployments/<network>.json and in the README. It exercises the real
 * registries; it is not evidence of real-world trust.
 *
 * Idempotent: progress is saved after every step, so a re-run resumes.
 *
 *   npx hardhat run scripts/seed-demo.ts --network monadTestnet
 */

const WALLETS_FILE = ".demo-wallets.json";
const ROLES = ["buyer", "seller", "newcomer", "reviewerA", "reviewerB", "reviewerC"] as const;
type Role = (typeof ROLES)[number];
const AGENTS = ["buyer", "seller", "newcomer"] as const;
type AgentRole = (typeof AGENTS)[number];
const REVIEWERS: Role[] = ["reviewerA", "reviewerB", "reviewerC"];

/**
 * Gas money for each demo wallet, in MON.
 *
 * Monad charges the gas LIMIT at a base fee of at least 100 gwei, and only
 * accepts a transaction if the sender can cover limit x maxFeePerGas up front.
 * On Monad testnet (2026-10-08) one feedback carried a 260,188 gas limit: it
 * cost 0.0265 MON at 102 gwei and needed 0.053 MON of balance at 202 gwei.
 * A rehearsal on a local fork had suggested half that, because it counted gas
 * used. Reviewers leave up to five feedbacks each, so they get 0.15 MON.
 */
const FUNDING: Record<Role, bigint> = {
  buyer: ethers.parseEther("0.25"),
  seller: ethers.parseEther("0.25"),
  newcomer: ethers.parseEther("0.06"),
  reviewerA: ethers.parseEther("0.15"),
  reviewerB: ethers.parseEther("0.15"),
  reviewerC: ethers.parseEther("0.15"),
};

/** Where each agent's ERC-8004 registration file points. Written on-chain at registration. */
const PROJECT_URL = process.env.PROJECT_URL ?? "https://github.com/kasbsquall/sealed";

/** Two-decimal feedback values (470 = 4.70), left round-robin by the three reviewers. */
const FEEDBACK: Record<AgentRole, number[]> = {
  buyer: [480, 460, 470, 490, 450, 470],
  seller: [440, 430, 450, 420, 460, 430],
  newcomer: [500],
};

/** The admission policy every demo negotiation uses. */
const POLICY_TEMPLATE = { minFeedbackCount: 5, minAverageValue: 400, decimals: 2, tag1: "" };

const DESCRIPTIONS: Record<AgentRole, string> = {
  buyer: "Demo buyer agent for Sealed. Negotiates a purchase price inside a mandate it never discloses.",
  seller: "Demo seller agent for Sealed. Negotiates a sale price inside a mandate it never discloses.",
  newcomer: "Demo agent for Sealed with a single review. Exists to show the reputation gate refusing admission.",
};

function agentURI(role: AgentRole): string {
  const registration = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: `Sealed demo ${role}`,
    description: DESCRIPTIONS[role],
    services: [{ name: "web", endpoint: PROJECT_URL }],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString("base64")}`;
}

function loadWallets(): Record<Role, string> {
  if (fs.existsSync(WALLETS_FILE)) return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  const keys = Object.fromEntries(ROLES.map((r) => [r, Wallet.createRandom().privateKey])) as Record<Role, string>;
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

async function send(label: string, tx: Promise<ContractTransactionResponse>) {
  const sent = await tx;
  const receipt = await sent.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed: ${sent.hash}`);
  console.log(`  ${label.padEnd(34)} ${sent.hash}`);
  return receipt;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const registries = REGISTRIES[chainId];
  if (!registries) throw new Error(`No ERC-8004 registries recorded for chain ${chainId}.`);

  const outFile = `deployments/${network.name}.json`;
  const state: any = fs.existsSync(outFile)
    ? JSON.parse(fs.readFileSync(outFile, "utf8"))
    : { network: network.name, chainId, registries, seeded: true, agents: {}, feedback: {}, transactions: {} };
  fs.mkdirSync("deployments", { recursive: true });
  const save = () => fs.writeFileSync(outFile, JSON.stringify(state, null, 2) + "\n");

  const [deployer] = await ethers.getSigners();
  console.log(`Network   ${network.name} (${chainId})`);
  console.log(`Deployer  ${deployer.address}  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} MON`);

  // 1. Contracts
  if (state.contracts && (await ethers.provider.getCode(state.contracts.SealedNegotiation)) === "0x") {
    throw new Error(`${outFile} points to contracts that do not exist on this network. Delete it to start over.`);
  }
  if (!state.contracts) {
    console.log("Deploying");
    const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(registries.identity, registries.reputation, await fees());
    await gate.waitForDeployment();
    const sealed = await (await ethers.getContractFactory("SealedNegotiation")).deploy(await gate.getAddress(), await fees());
    await sealed.waitForDeployment();
    state.contracts = { ReputationGate: await gate.getAddress(), SealedNegotiation: await sealed.getAddress() };
    state.transactions.deployReputationGate = gate.deploymentTransaction()?.hash;
    state.transactions.deploySealedNegotiation = sealed.deploymentTransaction()?.hash;
    save();
    console.log(`  ReputationGate      ${state.contracts.ReputationGate}`);
    console.log(`  SealedNegotiation   ${state.contracts.SealedNegotiation}`);
  }

  // 2. Demo wallets
  const keys = loadWallets();
  const wallets = Object.fromEntries(ROLES.map((r) => [r, new Wallet(keys[r], ethers.provider)])) as Record<Role, Wallet>;
  state.addresses = Object.fromEntries(ROLES.map((r) => [r, wallets[r].address]));
  save();

  console.log("Funding demo wallets");
  for (const role of ROLES) {
    const balance = await ethers.provider.getBalance(wallets[role].address);
    if (balance >= FUNDING[role] / 2n) continue;
    const tx = await deployer.sendTransaction({ to: wallets[role].address, value: FUNDING[role], ...(await fees()) });
    await tx.wait();
    console.log(`  fund ${role.padEnd(29)} ${tx.hash}`);
  }

  // 3. Agents in the ERC-8004 Identity Registry
  const identity = await ethers.getContractAt("IdentityRegistryUpgradeable", registries.identity);
  console.log("Registering agents");
  for (const role of AGENTS) {
    if (state.agents[role]) continue;
    const receipt = await send(`register ${role}`, identity.connect(wallets[role])["register(string)"](agentURI(role), await fees()));
    const event = receipt.logs
      .map((log) => {
        try {
          return identity.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "Registered");
    if (!event) throw new Error(`No Registered event for ${role}`);
    state.agents[role] = { agentId: event.args.agentId.toString(), wallet: wallets[role].address, registerTx: receipt.hash };
    save();
  }
  // Keeps each registration file current, e.g. after the project URL moves.
  for (const role of AGENTS) {
    const agentId = BigInt(state.agents[role].agentId);
    if ((await identity.tokenURI(agentId)) === agentURI(role)) continue;
    const receipt = await send(`update URI ${role}`, identity.connect(wallets[role]).setAgentURI(agentId, agentURI(role), await fees()));
    state.agents[role].uriTx = receipt.hash;
    save();
  }

  // 4. Feedback in the ERC-8004 Reputation Registry
  const reputation = await ethers.getContractAt("ReputationRegistryUpgradeable", registries.reputation);
  console.log("Leaving demo feedback");
  for (const role of AGENTS) {
    state.feedback[role] = state.feedback[role] ?? [];
    const done: string[] = state.feedback[role];
    const agentId = BigInt(state.agents[role].agentId);
    for (let i = done.length; i < FEEDBACK[role].length; i++) {
      const reviewer = wallets[REVIEWERS[i % REVIEWERS.length]];
      const receipt = await send(
        `feedback ${role} #${i + 1} (${FEEDBACK[role][i]})`,
        reputation.connect(reviewer).giveFeedback(agentId, FEEDBACK[role][i], 2, "", "", "", "", ethers.ZeroHash, await fees()),
      );
      done.push(receipt.hash);
      save();
    }
  }

  // 5. Check the gate against the live registries
  const policy = { reviewers: REVIEWERS.map((r) => wallets[r].address), ...POLICY_TEMPLATE };
  state.policy = policy;
  const gate = await ethers.getContractAt("ReputationGate", state.contracts.ReputationGate);
  console.log("Admission under the demo policy");
  state.admission = {};
  for (const role of AGENTS) {
    const agentId = BigInt(state.agents[role].agentId);
    const clears = await gate.clears(agentId, policy);
    const isWallet = await gate.isAgentWallet(agentId, wallets[role].address);
    state.admission[role] = { clears, isAgentWallet: isWallet };
    console.log(`  ${role.padEnd(9)} agentId ${String(agentId).padEnd(6)} wallet ok: ${isWallet}  clears: ${clears}`);
  }
  save();

  const expected = state.admission.buyer.clears && state.admission.seller.clears && !state.admission.newcomer.clears;
  if (!expected) throw new Error("Admission results do not match the demo design.");
  console.log(`Done. State in ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
