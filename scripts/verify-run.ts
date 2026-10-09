import fs from "fs";
import { AbiCoder, Interface, JsonRpcProvider } from "ethers";
import { commitmentHash } from "../agents/sealed/commitment";
import { admissionPolicyHash } from "../agents/sealed/policy";
import { REGISTRIES } from "./registries";

/**
 * Independent check of a published demo run against the chain. For every round
 * it reads the commit transactions from Monad testnet and confirms that:
 *
 *   - the transaction was sent by the party the transcript says,
 *   - its calldata carries only the commitment hash, never the offer,
 *   - the hash equals keccak(domain, negotiationId, party, commitIndex, offer, salt)
 *     for the offer and salt the transcript publishes.
 *
 * For a settled run it also checks that the settlement transaction disclosed
 * exactly the last round's offers, and, when the agents rated each other, that
 * each ERC-8004 review was given by one party to the other and points at that
 * settlement. When the transcript publishes its admission policy, it checks that
 * the contract stored that policy's hash for the negotiation. Needs no wallet
 * and no Hardhat network.
 *
 *   npx tsx scripts/verify-run.ts demo-runs/monadTestnet-deal-3.json
 *   (or: npx hardhat run scripts/verify-run.ts with RUN=demo-runs/...)
 */

const RPC = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const SEALED = new Interface([
  "function commitOffer(uint256 negotiationId, bytes32 commitment)",
  "function settle(uint256 negotiationId, (uint256 offer, bytes32 salt) buyerReveal, (uint256 offer, bytes32 salt) sellerReveal, bytes buyerAuthorization, bytes sellerAuthorization)",
  "function expire(uint256 negotiationId)",
  "function getNegotiation(uint256 negotiationId) view returns ((address buyerWallet, address sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 buyerCommitIndex, uint32 sellerCommitIndex, uint64 deadline, uint8 status, uint256 settledPrice, bytes32 termsSchema))",
]);
/** Deployments from the commit freeze on also store the admission policy's hash. Earlier ones return the shorter tuple above. */
const SEALED_WITH_POLICY = new Interface([
  "function getNegotiation(uint256 negotiationId) view returns ((address buyerWallet, address sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 buyerCommitIndex, uint32 sellerCommitIndex, uint64 deadline, uint8 status, uint256 settledPrice, bytes32 termsSchema, bytes32 policyHash))",
]);
const REPUTATION = new Interface([
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);
const STATUS_SETTLED = 3n;
const STATUS_EXPIRED = 4n;

async function main() {
  const file = process.argv[2] ?? process.env.RUN;
  if (!file) throw new Error("Usage: verify-run.ts <demo-runs/....json>");
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  const provider = new JsonRpcProvider(RPC);
  const domain = { chainId: BigInt(run.chainId), verifyingContract: run.contract };
  const negotiationId = BigInt(run.negotiationId);
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
    if (!ok) failures++;
  };

  console.log(`Run ${file}: negotiation ${negotiationId} on chain ${run.chainId}, outcome ${run.outcome}\n`);
  for (const round of run.rounds) {
    for (const role of ["buyer", "seller"] as const) {
      const side = round[role];
      const tx = await provider.getTransaction(side.commitTx);
      if (!tx) {
        check(false, `round ${round.round} ${role}: commit tx not found`);
        continue;
      }
      const decoded = SEALED.parseTransaction({ data: tx.data });
      const onChainCommitment = decoded?.args.commitment as string;
      const recomputed = commitmentHash({
        domain,
        negotiationId,
        party: run.agents[role].wallet,
        commitIndex: side.commitIndex,
        position: { offer: BigInt(side.offer), salt: side.salt },
      });
      const offerWord = AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(side.offer)]).slice(2);

      check(tx.from.toLowerCase() === run.agents[role].wallet.toLowerCase(), `round ${round.round} ${role}: sent by the ${role}'s wallet`);
      check(tx.to?.toLowerCase() === run.contract.toLowerCase() && decoded?.name === "commitOffer", `round ${round.round} ${role}: a commitOffer call to Sealed`);
      check(!tx.data.toLowerCase().includes(offerWord), `round ${round.round} ${role}: offer ${side.offer} absent from calldata`);
      check(onChainCommitment === recomputed, `round ${round.round} ${role}: on-chain hash matches offer ${side.offer} with the published salt`);
    }
  }

  if (run.outcome === "settled") {
    const tx = await provider.getTransaction(run.settleTx);
    const decoded = tx && SEALED.parseTransaction({ data: tx.data });
    const last = run.rounds.at(-1);
    check(!!decoded && decoded.name === "settle", "settlement is a settle call to Sealed");
    check(decoded?.args.buyerReveal.offer === BigInt(last.buyer.offer), `settlement disclosed buyer offer ${last.buyer.offer}`);
    check(decoded?.args.sellerReveal.offer === BigInt(last.seller.offer), `settlement disclosed seller offer ${last.seller.offer}`);
  } else {
    const tx = run.expireTx && (await provider.getTransaction(run.expireTx));
    const decoded = tx && SEALED.parseTransaction({ data: tx.data });
    check(!!decoded && decoded.name === "expire" && decoded.args.negotiationId === negotiationId, "negotiation was closed with an expire call to Sealed, which carries no offer");
  }

  const stateData = await provider.call({ to: run.contract, data: SEALED.encodeFunctionData("getNegotiation", [negotiationId]) });
  const state = SEALED.decodeFunctionResult("getNegotiation", stateData)[0];
  if (run.admissionPolicy) {
    // The policy the transcript publishes must be the one the contract checked and stored at creation.
    const stored = SEALED_WITH_POLICY.decodeFunctionResult("getNegotiation", stateData)[0].policyHash;
    check(stored === admissionPolicyHash(run.admissionPolicy), "contract state: stored admission policy hash matches the published policy");
  }
  if (run.outcome === "settled") {
    check(state.status === STATUS_SETTLED && state.settledPrice === BigInt(run.settledPrice), `contract state: Settled at ${run.settledPrice}`);
    for (const role of ["buyer", "seller"] as const) {
      const txHash = run.feedback?.[role];
      if (!txHash) continue;
      const other = role === "buyer" ? "seller" : "buyer";
      const receipt = await provider.getTransactionReceipt(txHash);
      // Only the canonical Reputation Registry counts; the same event from any other contract is ignored.
      const registry = REGISTRIES[Number(run.chainId)].reputation.toLowerCase();
      const event = receipt?.logs
        .filter((l) => l.address.toLowerCase() === registry)
        .map((l) => {
          try {
            return REPUTATION.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "NewFeedback");
      check(
        !!event &&
          receipt!.status === 1 &&
          event.args.clientAddress.toLowerCase() === run.agents[role].wallet.toLowerCase() &&
          event.args.agentId === BigInt(run.agents[other].agentId) &&
          event.args.feedbackHash === run.settleTx,
        `ERC-8004: the ${role} rated agent ${run.agents[other].agentId}, and the review points at this settlement`,
      );
    }
  } else {
    check(state.status === STATUS_EXPIRED && state.settledPrice === 0n, "contract state: Expired, no price recorded");
  }

  console.log(failures ? `\n${failures} check(s) failed.` : "\nEvery check passed.");
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
