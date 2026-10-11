import { Contract, type BaseWallet } from "ethers";
import { chainFees } from "../sealed/fees";

const COMMIT_BY_SIG_ABI = ["function commitOfferBySig(uint256 negotiationId, address party, bytes32 commitment, bytes signature)"];

/**
 * Submits a party's signed commitment and waits for it. The desk sends both
 * sides' commits of a round at once, so each is estimated before the other is
 * mined; whichever lands second also locks the negotiation and needs more gas
 * than its estimate. Monad charges the limit, so the headroom is modest.
 */
export async function submitCommit(submitter: BaseWallet, sealed: string, negotiationId: bigint, party: string, commitment: string, signature: string) {
  const contract = new Contract(sealed, COMMIT_BY_SIG_ABI, submitter);
  const estimate: bigint = await contract.commitOfferBySig.estimateGas(negotiationId, party, commitment, signature);
  const tx = await contract.commitOfferBySig(negotiationId, party, commitment, signature, {
    ...(await chainFees(submitter.provider!)),
    gasLimit: (estimate * 3n) / 2n,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`commit failed: ${tx.hash}`);
  return tx.hash as string;
}
