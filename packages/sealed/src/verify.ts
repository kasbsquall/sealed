import { Contract, Interface, dataLength, getAddress, id as eventTopic, recoverAddress, toBeHex, zeroPadValue, type Log } from "ethers";
import { commitmentHash, type SealedDomain } from "../../../agents/sealed/commitment";
import { SEALED_NEGOTIATION_ABI } from "./abis";
import { settleAuthorizationDigest } from "./encoding";
import type { Negotiation, SealedReader } from "./read";

export interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SettledSide {
  wallet: string;
  agentId: bigint;
  offer: bigint;
  salt: string;
  commitIndex: number;
  commitment: string;
  /** The commitOffer transaction that put `commitment` on-chain, when found within the lookback. */
  commitTx: string | null;
}

export interface SettlementReport {
  txHash: string;
  /** True when every check passed. */
  ok: boolean;
  checks: Check[];
  negotiationId?: bigint;
  contract?: string;
  blockNumber?: number;
  price?: bigint;
  buyer?: SettledSide;
  seller?: SettledSide;
}

export interface VerifyOptions {
  /** How far back from the settlement block to look for the final commit transactions. Default 3000. */
  lookbackBlocks?: number;
  /** Blocks per eth_getLogs request. Monad's public RPC serves at most 100. */
  logChunk?: number;
}

const sealedInterface = new Interface(SEALED_NEGOTIATION_ABI);
const OFFER_COMMITTED = eventTopic("OfferCommitted(uint256,address,uint32)");
const SETTLED = sealedInterface.getEvent("NegotiationSettled")!;
const COMMIT_CALLDATA_BYTES = 68;
const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Checks a settlement against the chain alone, with no transcript and no key:
 * decodes the settle calldata, recomputes both commitments from the disclosed
 * offers and salts, compares them with what the contract stored and with the
 * commit transactions that put them there, recovers both EIP-712 signers, and
 * checks the NegotiationSettled event and the stored price against the
 * midpoint. The same checks scripts/verify-run.ts makes for a published run.
 */
export async function verifySettlement(reader: SealedReader, txHash: string, options: VerifyOptions = {}): Promise<SettlementReport> {
  const checks: Check[] = [];
  const check = (ok: boolean, label: string, detail?: string) => checks.push({ label, ok, ...(detail ? { detail } : {}) });
  const done = (extra: Partial<SettlementReport> = {}): SettlementReport => ({ txHash, ok: checks.every((c) => c.ok), checks, ...extra });

  const [tx, receipt] = await Promise.all([reader.provider.getTransaction(txHash), reader.provider.getTransactionReceipt(txHash)]);
  if (!tx || !receipt) {
    check(false, "transaction found on-chain");
    return done();
  }
  const call = safeParse(tx.data);
  check(receipt.status === 1, "transaction succeeded");
  check(sameAddress(tx.to, reader.deployment.sealedNegotiation), `sent to SealedNegotiation at ${reader.deployment.sealedNegotiation}`, `to ${tx.to}`);
  check(call?.name === "settle", "is a settle call", call ? `decoded ${call.name}` : "calldata is not a Sealed call");
  if (!call || call.name !== "settle" || !tx.to) return done({ blockNumber: receipt.blockNumber });

  const contract = getAddress(tx.to);
  const negotiationId: bigint = call.args.negotiationId;
  const domain = await readDomain(reader, contract, checks);
  const state = await reader.getNegotiation(negotiationId, contract);
  const buyerOffer: bigint = call.args.buyerReveal.offer;
  const sellerOffer: bigint = call.args.sellerReveal.offer;
  const sides = {
    buyer: { wallet: state.buyerWallet, agentId: state.buyerAgentId, offer: buyerOffer, salt: call.args.buyerReveal.salt, commitIndex: state.buyerCommitIndex, commitment: state.buyerCommitment, commitTx: null as string | null },
    seller: { wallet: state.sellerWallet, agentId: state.sellerAgentId, offer: sellerOffer, salt: call.args.sellerReveal.salt, commitIndex: state.sellerCommitIndex, commitment: state.sellerCommitment, commitTx: null as string | null },
  };

  for (const role of ["buyer", "seller"] as const) {
    const side = sides[role];
    const recomputed = commitmentHash({ domain, negotiationId, party: side.wallet, commitIndex: side.commitIndex, position: { offer: side.offer, salt: side.salt } });
    const onContract: string = await new Contract(contract, SEALED_NEGOTIATION_ABI, reader.provider).commitmentHash(negotiationId, side.wallet, side.commitIndex, side.offer, side.salt);
    check(recomputed === side.commitment, `${role}: offer ${side.offer} with the disclosed salt hashes to the stored commitment #${side.commitIndex}`, recomputed);
    check(onContract === recomputed, `${role}: the contract's own commitmentHash agrees with the off-chain encoder`);
  }

  const digest = settleAuthorizationDigest(domain, {
    negotiationId,
    buyerCommitment: state.buyerCommitment,
    sellerCommitment: state.sellerCommitment,
    buyerCommitIndex: state.buyerCommitIndex,
    sellerCommitIndex: state.sellerCommitIndex,
  });
  const onChainDigest: string = await new Contract(contract, SEALED_NEGOTIATION_ABI, reader.provider).settleAuthorizationDigest(negotiationId);
  check(digest === onChainDigest, "EIP-712 SettleAuthorization digest matches the contract's");
  check(sameAddress(safeRecover(digest, call.args.buyerAuthorization), state.buyerWallet), "buyer's wallet signed the authorization for this commitment pair");
  check(sameAddress(safeRecover(digest, call.args.sellerAuthorization), state.sellerWallet), "seller's wallet signed the authorization for this commitment pair");

  const price = sellerOffer + (buyerOffer - sellerOffer) / 2n;
  check(buyerOffer >= sellerOffer, `offers cross: buyer ${buyerOffer} >= seller ${sellerOffer}`);
  const event = receipt.logs.filter((l) => sameAddress(l.address, contract) && l.topics[0] === SETTLED.topicHash).map((l) => sealedInterface.parseLog(l))[0];
  check(!!event && event.args.negotiationId === negotiationId && event.args.price === price, `NegotiationSettled(${negotiationId}, ${price}) emitted: the midpoint`);
  check(state.status === "Settled" && state.settledPrice === price, `contract state: Settled at ${price}`, `${state.status} at ${state.settledPrice}`);

  await checkCommitTransactions(reader, contract, state, sides, receipt.blockNumber, options, check);
  return done({ negotiationId, contract, blockNumber: receipt.blockNumber, price, buyer: sides.buyer, seller: sides.seller });
}

function safeParse(data: string) {
  try {
    return sealedInterface.parseTransaction({ data });
  } catch {
    return null;
  }
}

function safeRecover(digest: string, signature: string): string | null {
  try {
    return recoverAddress(digest, signature);
  } catch {
    return null;
  }
}

async function readDomain(reader: SealedReader, contract: string, checks: Check[]): Promise<SealedDomain> {
  const [, name, version, chainId, verifyingContract] = await new Contract(contract, SEALED_NEGOTIATION_ABI, reader.provider).eip712Domain();
  const network = await reader.provider.getNetwork();
  const ok = name === "Sealed" && version === "1" && chainId === network.chainId && sameAddress(verifyingContract, contract);
  checks.push({ label: "EIP-712 domain is Sealed v1 on this chain and contract", ok, detail: `${name} ${version}, chain ${chainId}` });
  return { chainId, verifyingContract };
}

/**
 * Finds, by walking back from the settlement in chunks the public RPC accepts,
 * the commitOffer transactions that produced the final commit indices, and
 * checks that each was sent by its party, carried the stored hash, and did not
 * carry the offer.
 */
async function checkCommitTransactions(
  reader: SealedReader,
  contract: string,
  state: Negotiation,
  sides: Record<"buyer" | "seller", SettledSide>,
  settleBlock: number,
  options: VerifyOptions,
  check: (ok: boolean, label: string, detail?: string) => void,
) {
  const lookback = options.lookbackBlocks ?? 3000;
  const chunk = options.logChunk ?? 100;
  const wanted = new Map<string, "buyer" | "seller">([
    [`${state.buyerWallet.toLowerCase()}:${state.buyerCommitIndex}`, "buyer"],
    [`${state.sellerWallet.toLowerCase()}:${state.sellerCommitIndex}`, "seller"],
  ]);
  const idTopic = zeroPadValue(toBeHex(state.negotiationId), 32);
  const floor = Math.max(0, settleBlock - lookback);
  for (let to = settleBlock; to >= floor && wanted.size > 0; to -= chunk) {
    const logs: Log[] = await reader.provider.getLogs({ address: contract, topics: [OFFER_COMMITTED, idTopic], fromBlock: Math.max(floor, to - chunk + 1), toBlock: to });
    for (const log of logs) {
      const parsed = sealedInterface.parseLog(log);
      const key = `${String(parsed?.args.party).toLowerCase()}:${Number(parsed?.args.commitIndex)}`;
      const role = wanted.get(key);
      if (!role) continue;
      sides[role].commitTx = log.transactionHash;
      wanted.delete(key);
    }
  }
  for (const role of ["buyer", "seller"] as const) {
    const side = sides[role];
    if (!side.commitTx) {
      check(false, `${role}: commit #${side.commitIndex} found within ${lookback} blocks of the settlement`, "raise lookbackBlocks");
      continue;
    }
    const tx = await reader.provider.getTransaction(side.commitTx);
    const parsed = tx ? safeParse(tx.data) : null;
    check(
      !!tx && sameAddress(tx.from, side.wallet) && parsed?.name === "commitOffer" && parsed.args.commitment === side.commitment,
      `${role}: commit #${side.commitIndex} (${side.commitTx}) was sent by the ${role} and carried the stored hash`,
    );
    // commitOffer(uint256,bytes32) is 4 + 64 bytes. Anything longer could carry more than the hash.
    check(
      !!tx && dataLength(tx.data) === COMMIT_CALLDATA_BYTES && parsed?.args.negotiationId === state.negotiationId,
      `${role}: the commit calldata is only the negotiation id and the hash, so offer ${side.offer} is not in it`,
    );
  }
}
