import "dotenv/config";
import fs from "fs";
import { spawn, type ChildProcess } from "child_process";
import { id, JsonRpcProvider, Wallet } from "ethers";
import { ClearingRelay } from "../agents/relay/clearingRelay";
import { HttpParty } from "../agents/relay/party";
import { llmConfigFromEnv } from "../agents/llm/client";
import { SCENARIOS, TERMS, type ScenarioName } from "./demo-config";

/**
 * The demo negotiation with the three roles in three OS processes:
 *
 *   buyer agent    its own process, its own key, its own model client
 *   seller agent   its own process, its own key, its own model client
 *   relay          this process; it holds only the relayer key that pays gas
 *
 * This process never reads .demo-wallets.json. The relay reaches each agent
 * over HTTP on 127.0.0.1 and gets a commitment, then a reveal once the
 * commitment is on-chain, then a signature if the numbers crossed. It still
 * sees both numbers of each round; that is the trust it is given.
 *
 *   npx tsx scripts/run-separated.ts                 (the deal scenario)
 *   DEMO_SCENARIOS=no-deal npx tsx scripts/run-separated.ts
 *
 * Writes demo-runs/monadTestnet-<scenario>-<id>-separated.json, which
 * scripts/verify-run.ts checks like any other run.
 */

const RPC = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const AGENT_PORTS = { buyer: 4101, seller: 4102 } as const;
const READY_TIMEOUT_MS = 60_000;

function startAgent(role: "buyer" | "seller", limit: bigint): Promise<{ child: ChildProcess; pid: number; url: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/agent-process.ts"], {
    env: { ...process.env, ROLE: role, LIMIT: limit.toString(), PORT: String(AGENT_PORTS[role]) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} agent did not start`)), READY_TIMEOUT_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      const line = chunk.toString().split("\n").find((l) => l.startsWith("READY "));
      if (!line) return;
      clearTimeout(timer);
      const [, pid, , url] = line.trim().split(" ");
      resolve({ child, pid: Number(pid), url });
    });
    child.on("exit", (code) => reject(new Error(`${role} agent exited with ${code}`)));
  });
}

async function main() {
  const state = JSON.parse(fs.readFileSync("deployments/monadTestnet.json", "utf8"));
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY missing; the relay pays gas with it.");
  const relayer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, new JsonRpcProvider(RPC));
  const domain = { chainId: BigInt(state.chainId), verifyingContract: state.contracts.SealedNegotiation };
  const relay = new ClearingRelay(relayer, domain);
  const llmConfig = llmConfigFromEnv();
  const selected = (process.env.DEMO_SCENARIOS?.split(",") ?? ["deal"]) as ScenarioName[];

  for (const name of selected) {
    const scenario = SCENARIOS[name];
    console.log(`\n== ${name} (separated): buyer limit ${scenario.buyerLimit}, seller limit ${scenario.sellerLimit}`);
    const agents = await Promise.all([startAgent("buyer", scenario.buyerLimit), startAgent("seller", scenario.sellerLimit)]);
    try {
      const [buyer, seller] = await Promise.all(agents.map((a) => HttpParty.connect(a.url)));
      console.log(`  relay pid ${process.pid} · buyer pid ${agents[0].pid} · seller pid ${agents[1].pid}`);
      const startedAt = new Date().toISOString();
      const record = await relay.negotiate({
        buyer: { agent: buyer, agentId: BigInt(state.agents.buyer.agentId) },
        seller: { agent: seller, agentId: BigInt(state.agents.seller.agentId) },
        termsSchema: id(TERMS),
        policy: state.policy,
        maxRounds: 3,
        windowSeconds: scenario.windowSeconds,
        onEvent: (m) => console.log(`  ${m}`),
      });

      const transcript = {
        scenario: name,
        network: "monadTestnet",
        chainId: state.chainId,
        contract: state.contracts.SealedNegotiation,
        relay: relayer.address,
        model: llmConfig.model,
        modelHost: llmConfig.baseUrl.includes("localhost") ? "local (Ollama on the operator's machine)" : llmConfig.baseUrl,
        terms: TERMS,
        termsSchema: id(TERMS),
        referencePrice: "4000",
        disclosure: "Demo only: mandates, offers, stances and salts are published so every on-chain hash can be recomputed. A real agent never discloses them.",
        separation: {
          note: "Three OS processes on one machine. Each agent process loaded only its own key and limit; the relay process never read the agents' keys and reached them over HTTP on 127.0.0.1.",
          relayPid: process.pid,
          buyerPid: agents[0].pid,
          sellerPid: agents[1].pid,
        },
        agents: {
          buyer: { agentId: state.agents.buyer.agentId, wallet: buyer.wallet.address, limit: scenario.buyerLimit.toString() },
          seller: { agentId: state.agents.seller.agentId, wallet: seller.wallet.address, limit: scenario.sellerLimit.toString() },
        },
        startedAt,
        finishedAt: new Date().toISOString(),
        ...record,
      };
      const file = `demo-runs/monadTestnet-${name}-${record.negotiationId}-separated.json`;
      fs.writeFileSync(file, JSON.stringify(transcript, null, 2) + "\n");
      console.log(`  outcome ${record.outcome}${record.settledPrice ? ` at ${record.settledPrice}` : ""} · ${file}`);
    } finally {
      agents.forEach((a) => a.child.kill());
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
