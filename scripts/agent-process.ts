import fs from "fs";
import { JsonRpcProvider, Wallet } from "ethers";
import { NegotiatorAgent } from "../agents/negotiator/negotiator";
import { LocalPartyWallet } from "../agents/wallets/partyWallet";
import { OpenAICompatibleClient, llmConfigFromEnv } from "../agents/llm/client";
import { OnChainView } from "../agents/negotiator/chainView";
import { serveParty, serverUrl } from "../agents/relay/party";
import { MAX_ROUNDS, REFERENCE, UNIT } from "./demo-config";

/**
 * One negotiating agent in its own OS process. It reads only its own key file,
 * gets its limit and the model settings from the environment it is started
 * with, and serves the relay on 127.0.0.1. It does not load .env. Started by
 * scripts/run-separated.ts with ROLE, LIMIT, PORT, AGENT_KEY_FILE and
 * PARTY_TOKEN, the secret the relay must present on every request.
 */

const RPC = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";

async function main() {
  const role = process.env.ROLE;
  if (role !== "buyer" && role !== "seller") throw new Error("ROLE must be buyer or seller");
  const limit = BigInt(process.env.LIMIT ?? "");
  const deployment = JSON.parse(fs.readFileSync("deployments/monadTestnet.json", "utf8"));
  const keyFile = process.env.AGENT_KEY_FILE;
  if (!keyFile) throw new Error("AGENT_KEY_FILE missing; the launcher passes this agent's own key file");
  const key = fs.readFileSync(keyFile, "utf8").trim();

  const domain = { chainId: BigInt(deployment.chainId), verifyingContract: deployment.contracts.SealedNegotiation };
  const provider = new JsonRpcProvider(RPC);
  const chain = new OnChainView(provider, deployment.contracts.SealedNegotiation, deployment.registries.reputation);
  const agent = new NegotiatorAgent(
    role,
    { role, limit, reference: REFERENCE, maxRounds: MAX_ROUNDS, unit: UNIT },
    new LocalPartyWallet(new Wallet(key, provider), domain),
    new OpenAICompatibleClient(llmConfigFromEnv()),
    domain,
    { chain, reviewers: deployment.policy.reviewers, dealFeedback: { provider, reputationRegistry: deployment.registries.reputation } },
  );
  const token = process.env.PARTY_TOKEN;
  if (!token) throw new Error("PARTY_TOKEN missing; the relay passes it when it starts this process");
  const server = await serveParty(agent, token, Number(process.env.PORT ?? 0));
  // The parent waits for this line before it lets the relay connect.
  console.log(`READY ${process.pid} ${agent.wallet.address} ${serverUrl(server)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
