import fs from "fs";
import { ethers, network } from "hardhat";
import { AbiCoder, Wallet } from "ethers";
import { commitmentHash, newSalt, settleAuthorizationTypedData, type Position } from "../agents/sealed/commitment";
import { fees } from "./fees";

/**
 * One scripted negotiation on a live network, end to end, with no LLM in the
 * loop. It proves the deployed contracts, the canonical ERC-8004 registries and
 * the off-chain commitment encoder work together on-chain:
 *
 *   1. the reputation gate refuses the newcomer agent,
 *   2. buyer and seller open a negotiation and each commit a sealed position,
 *   3. neither commit transaction carries the offer anywhere in its calldata,
 *   4. both sign the EIP-712 authorization and settle in one transaction.
 *
 * Requires scripts/seed-demo.ts to have run on the same network.
 *
 *   npx hardhat run scripts/smoke-negotiation.ts --network monadTestnet
 */

// Prices in US cents. Buyer's ceiling 42.50, seller's floor 39.80.
const BUYER_CEILING = 4_250n;
const SELLER_FLOOR = 3_980n;
const TERMS = "Demo: USD cents per unit, 1,000 units, net 30";

async function main() {
  const outFile = `deployments/${network.name}.json`;
  const state = JSON.parse(fs.readFileSync(outFile, "utf8"));
  const keys = JSON.parse(fs.readFileSync(".demo-wallets.json", "utf8"));
  const buyer = new Wallet(keys.buyer, ethers.provider);
  const seller = new Wallet(keys.seller, ethers.provider);
  const newcomer = new Wallet(keys.newcomer, ethers.provider);

  const sealed = await ethers.getContractAt("SealedNegotiation", state.contracts.SealedNegotiation);
  const gate = await ethers.getContractAt("ReputationGate", state.contracts.ReputationGate);
  const domain = { chainId: BigInt(state.chainId), verifyingContract: state.contracts.SealedNegotiation };
  const policy = state.policy;
  const ids = {
    buyer: BigInt(state.agents.buyer.agentId),
    seller: BigInt(state.agents.seller.agentId),
    newcomer: BigInt(state.agents.newcomer.agentId),
  };
  const latest = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const termsSchema = ethers.id(TERMS);

  // 1. The gate refuses an agent without enough trusted history.
  let refused = false;
  try {
    await sealed
      .connect(buyer)
      .createNegotiation.staticCall(ids.buyer, buyer.address, ids.newcomer, newcomer.address, (await latest()) + 1800n, termsSchema, policy);
  } catch (error: any) {
    // A public RPC returns the revert as hex; a local Hardhat node wraps it as
    // { data, message }. Accept both.
    const revertData = typeof error.data === "string" ? error.data : error.data?.data;
    refused = gate.interface.parseError(revertData)?.name === "NotAdmitted";
  }
  if (!refused) throw new Error("Expected the gate to refuse the newcomer with NotAdmitted");
  console.log("Gate      newcomer refused with NotAdmitted");

  // 2. Open the negotiation.
  const createTx = await sealed
    .connect(buyer)
    .createNegotiation(ids.buyer, buyer.address, ids.seller, seller.address, (await latest()) + 1800n, termsSchema, policy, await fees());
  const createReceipt = await createTx.wait();
  const created = createReceipt!.logs
    .map((log) => {
      try {
        return sealed.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "NegotiationCreated");
  const negotiationId: bigint = created!.args.negotiationId;
  console.log(`Created   negotiation ${negotiationId}  ${createTx.hash}`);

  // 3. Each side commits a sealed position. Offers and salts never leave this process until settle.
  const positions: Record<"buyer" | "seller", Position> = {
    buyer: { offer: BUYER_CEILING, salt: newSalt() },
    seller: { offer: SELLER_FLOOR, salt: newSalt() },
  };
  const commitTxs: Record<string, string> = {};
  for (const [role, wallet] of [["buyer", buyer], ["seller", seller]] as const) {
    const n = await sealed.getNegotiation(negotiationId);
    const commitIndex = Number(role === "buyer" ? n.buyerCommitIndex : n.sellerCommitIndex) + 1;
    const commitment = commitmentHash({ domain, negotiationId, party: wallet.address, commitIndex, position: positions[role] });
    const tx = await sealed.connect(wallet).commitOffer(negotiationId, commitment, await fees());
    await tx.wait();
    commitTxs[role] = tx.hash;

    // The offer, ABI-encoded as it would appear if it leaked, must not be in the calldata.
    const encodedOffer = AbiCoder.defaultAbiCoder().encode(["uint256"], [positions[role].offer]).slice(2);
    const calldata = (await ethers.provider.getTransaction(tx.hash))!.data.toLowerCase();
    if (calldata.includes(encodedOffer)) throw new Error(`${role} offer visible in commit calldata`);
    console.log(`Commit    ${role.padEnd(6)} offer absent from calldata  ${tx.hash}`);
  }

  // 4. Both authorize this exact pair of commitments, then settle atomically.
  const n = await sealed.getNegotiation(negotiationId);
  const typed = settleAuthorizationTypedData(domain, {
    negotiationId,
    buyerCommitment: n.buyerCommitment,
    sellerCommitment: n.sellerCommitment,
    buyerCommitIndex: Number(n.buyerCommitIndex),
    sellerCommitIndex: Number(n.sellerCommitIndex),
  });
  const types = { SettleAuthorization: [...typed.types.SettleAuthorization] };
  const buyerAuth = await buyer.signTypedData(typed.domain, types, typed.message);
  const sellerAuth = await seller.signTypedData(typed.domain, types, typed.message);

  const settleTx = await sealed
    .connect(buyer)
    .settle(negotiationId, positions.buyer, positions.seller, buyerAuth, sellerAuth, await fees());
  await settleTx.wait();
  const price = (await sealed.getNegotiation(negotiationId)).settledPrice;
  console.log(`Settled   price ${price} (midpoint of ${SELLER_FLOOR} and ${BUYER_CEILING})  ${settleTx.hash}`);

  state.smoke = {
    note: "Scripted smoke test, no LLM. Offers chosen by the script.",
    negotiationId: negotiationId.toString(),
    terms: TERMS,
    newcomerRefused: true,
    createTx: createTx.hash,
    commitTxs,
    settleTx: settleTx.hash,
    settledPrice: price.toString(),
  };
  fs.writeFileSync(outFile, JSON.stringify(state, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
