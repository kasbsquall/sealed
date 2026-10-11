import fs from "fs";
import path from "path";
import { config as loadEnv } from "dotenv";
import { JsonRpcProvider, Wallet, formatEther, id, parseEther } from "ethers";
import { Desk } from "../agents/desk/desk";
import { deskApp } from "../agents/desk/server";
import { SerialWallet } from "../agents/desk/serialWallet";
import { TERMS, UNIT } from "./demo-config";

/**
 * Runs the Sealed desk on Monad testnet. Keys and the seller's floor come from
 * .desk.env (scripts/desk-keys.ts writes it), never from the repository.
 * Listens on 127.0.0.1 only; put a TLS reverse proxy in front of it.
 *
 *   npx tsx scripts/desk.ts
 */
loadEnv({ path: process.env.DESK_ENV ?? ".desk.env" });

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} missing; run scripts/desk-keys.ts first`);
  return value;
};

// The price unit is US cents per 1,000 calls; a deal is 1,000,000 calls, paid in a 6-decimal test dollar.
const CALLS = 1_000_000n;
const SCALE = 10_000n * (CALLS / 1_000n);

async function main() {
  const state = JSON.parse(fs.readFileSync(process.env.DESK_DEPLOYMENTS ?? "deployments/monadTestnet.json", "utf8"));
  const v3 = state.contractsV3;
  if (!v3) throw new Error("no contractsV3 in deployments/monadTestnet.json");
  const provider = new JsonRpcProvider(process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz");
  const operator = new SerialWallet(need("DESK_OPERATOR_KEY"), provider);
  const sellerKey = new Wallet(need("DESK_SELLER_KEY"), provider);
  const dataFile = process.env.DESK_DATA ?? "desk-data/desk.json";
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });

  const desk = new Desk({
    operator,
    sellerKey,
    chainId: BigInt(state.chainId),
    contracts: { sealed: v3.SealedNegotiationV3, token: v3.SealedTestUSD, identity: state.registries.identity },
    terms: TERMS,
    termsSchema: id(TERMS),
    unit: UNIT,
    scale: SCALE,
    calls: CALLS,
    listing: { listPrice: BigInt(process.env.DESK_LIST_PRICE ?? "4400"), floor: BigInt(need("DESK_SELLER_FLOOR")), finalMargin: 40n, maxRounds: 3 },
    // Open admission: no reviews required. 0xdEaD has no key, so it never reviews anyone,
    // and the gate still checks that the wallet is the agent's registered one.
    policy: { reviewers: ["0x000000000000000000000000000000000000dEaD"], minFeedbackCount: 0n, minAverageValue: 0n, decimals: 0, tag1: "" },
    guestFloat: 50_000n * 1_000_000n,
    windowSeconds: 1800,
    limits: {
      maxOpenSessions: Number(process.env.DESK_MAX_OPEN ?? 3),
      maxGuestsPerDay: Number(process.env.DESK_MAX_GUESTS ?? 40),
      maxSessionsPerDay: Number(process.env.DESK_MAX_SESSIONS ?? 60),
      minOperatorBalance: parseEther(process.env.DESK_MIN_MON ?? "0.25"),
    },
    dataFile,
    // A guest is a model behind tool calls: give it minutes per step, not seconds.
    timeouts: { decideTimeoutMs: 10 * 60_000, commitTimeoutMs: 150_000, revealTimeoutMs: 5 * 60_000, authorizeTimeoutMs: 5 * 60_000 },
  });

  console.log(`operator ${operator.address}  ${formatEther(await provider.getBalance(operator.address))} MON`);
  console.log(`seller   ${sellerKey.address}`);
  await desk.prepare();
  console.log(`seller agent ${desk.sellerAgentId}`);

  // In a container, DESK_HOST=0.0.0.0 and the port is published on the host's loopback only.
  const port = Number(process.env.DESK_PORT ?? 8787);
  const host = process.env.DESK_HOST ?? "127.0.0.1";
  deskApp(desk, process.env.DESK_TRUSTED_PROXY ?? "loopback").listen(port, host, () => console.log(`desk listening on ${host}:${port}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
