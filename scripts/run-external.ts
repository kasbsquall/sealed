import "dotenv/config";
import fs from "fs";
import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { id, JsonRpcProvider, Wallet } from "ethers";
import { ClearingRelay } from "../agents/relay/clearingRelay";
import { HttpParty } from "../agents/relay/party";
import { llmConfigFromEnv } from "../agents/llm/client";
import { SCENARIOS, TERMS } from "./demo-config";

/**
 * A negotiation against a seller agent that is not in this repository:
 *
 *   buyer agent    the Sealed Qwen negotiator, its own process and key (as in run-separated.ts)
 *   seller agent   started by its operator from its own repository, with its own key and floor,
 *                  e.g. kasbsquall/sealed-seller-agent, built on the sealed-monad package only
 *   relay          this process; it holds only the relayer key that pays gas
 *
 * The relay knows the seller only by its URL, its bearer token and its ERC-8004
 * agent id. It never learns the seller's floor except as an offer the seller
 * chose to commit, and the transcript records the floor as unknown.
 *
 *   EXTERNAL_SELLER_URL=http://127.0.0.1:4201 EXTERNAL_SELLER_TOKEN=<secret> \
 *   EXTERNAL_SELLER_AGENT_ID=2126 npx tsx scripts/run-external.ts
 *
 * Writes demo-runs/monadTestnet-v2-external-seller-<id>.json, which
 * scripts/verify-run.ts checks like any other run.
 */

const RPC = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const BUYER_PORT = 4101;
const READY_TIMEOUT_MS = 60_000;
/** One file per agent holding only that agent's key, written by `npm run keys:agents`. */
const agentKeyFile = (role: "buyer" | "seller") => `.agent-keys/${role}.key`;
/** What an agent process inherits: enough for Node and its model client, and no other secret. */
const INHERITED_ENV = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "MONAD_RPC_URL", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_TIMEOUT_MS"];

function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

function startAgent(role: "buyer" | "seller", limit: bigint): Promise<{ child: ChildProcess; pid: number; url: string; token: string }> {
  // A fresh secret per agent per run, known only to that agent and this relay.
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/agent-process.ts"], {
    env: agentEnv({ ROLE: role, LIMIT: limit.toString(), PORT: String(BUYER_PORT), PARTY_TOKEN: token, AGENT_KEY_FILE: agentKeyFile(role) }),
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} agent did not start`)), READY_TIMEOUT_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      const line = chunk.toString().split("\n").find((l) => l.startsWith("READY "));
      if (!line) return;
      clearTimeout(timer);
      const [, pid, , url] = line.trim().split(" ");
      resolve({ child, pid: Number(pid), url, token });
    });
    child.on("exit", (code) => reject(new Error(`${role} agent exited with ${code}`)));
  });
}

async function main() {
  const state = JSON.parse(fs.readFileSync("deployments/monadTestnet.json", "utf8"));
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY missing; the relay pays gas with it.");
  if (!fs.existsSync(agentKeyFile("buyer"))) throw new Error(`${agentKeyFile("buyer")} missing; run npm run keys:agents once`);
  const sellerUrl = process.env.EXTERNAL_SELLER_URL;
  const sellerToken = process.env.EXTERNAL_SELLER_TOKEN;
  const sellerAgentId = process.env.EXTERNAL_SELLER_AGENT_ID;
  if (!sellerUrl || !sellerToken || !sellerAgentId) throw new Error("EXTERNAL_SELLER_URL, EXTERNAL_SELLER_TOKEN and EXTERNAL_SELLER_AGENT_ID are required");
  const relayer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, new JsonRpcProvider(RPC));
  const domain = { chainId: BigInt(state.chainId), verifyingContract: state.contracts.SealedNegotiation };
  const relay = new ClearingRelay(relayer, domain);
  const llmConfig = llmConfigFromEnv();
  const scenario = SCENARIOS.deal;

  console.log(`\n== external seller: buyer limit ${scenario.buyerLimit}, seller floor unknown to the relay`);
  const buyerProcess = await startAgent("buyer", scenario.buyerLimit);
  try {
    const [buyer, seller] = await Promise.all([HttpParty.connect(buyerProcess.url, buyerProcess.token), HttpParty.connect(sellerUrl, sellerToken)]);
    console.log(`  relay pid ${process.pid} · buyer pid ${buyerProcess.pid} · seller ${seller.wallet.address} at ${sellerUrl}`);
    const startedAt = new Date().toISOString();
    const record = await relay.negotiate({
      buyer: { agent: buyer, agentId: BigInt(state.agents.buyer.agentId) },
      seller: { agent: seller, agentId: BigInt(sellerAgentId) },
      termsSchema: id(TERMS),
      policy: state.policy,
      maxRounds: 3,
      windowSeconds: scenario.windowSeconds,
      onEvent: (m) => console.log(`  ${m}`),
    });

    const transcript = {
      scenario: "external-seller",
      network: "monadTestnet",
      chainId: state.chainId,
      contract: state.contracts.SealedNegotiation,
      relay: relayer.address,
      model: `buyer: ${llmConfig.model}; seller: rule-based schedule, no model`,
      modelHost: llmConfig.baseUrl.includes("localhost") ? "local (Ollama on the operator's machine)" : llmConfig.baseUrl,
      terms: TERMS,
      termsSchema: id(TERMS),
      referencePrice: "4000",
      admissionPolicy: state.policy,
      disclosure: "Demo only: the buyer's mandate, both sides' offers and salts are published so every on-chain hash can be recomputed. A real agent never discloses them.",
      separation: {
        note: "The buyer ran as its own OS process from this repository with only its own key. The seller ran from a separate repository (kasbsquall/sealed-seller-agent), built on the published sealed-monad package, with its own key and floor; the relay reached both over HTTP on 127.0.0.1. The seller's repository is by the same author as Sealed: this run shows the integration path works from outside the codebase, not adoption by another team.",
        relayPid: process.pid,
        buyerPid: buyerProcess.pid,
        sellerRepository: "https://github.com/kasbsquall/sealed-seller-agent",
      },
      agents: {
        buyer: { agentId: state.agents.buyer.agentId, wallet: buyer.wallet.address, limit: scenario.buyerLimit.toString() },
        seller: { agentId: sellerAgentId, wallet: seller.wallet.address, limit: null, limitNote: "Not known to the relay; the seller agent keeps it." },
      },
      startedAt,
      finishedAt: new Date().toISOString(),
      ...record,
    };
    const file = `demo-runs/monadTestnet-v2-external-seller-${record.negotiationId}.json`;
    fs.writeFileSync(file, JSON.stringify(transcript, null, 2) + "\n");
    console.log(`  outcome ${record.outcome}${record.settledPrice ? ` at ${record.settledPrice}` : ""} · ${file}`);
  } finally {
    buyerProcess.child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
