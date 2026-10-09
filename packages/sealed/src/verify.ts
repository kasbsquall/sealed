import { Contract, Interface, dataLength, getAddress, id as eventTopic, recoverAddress, toBeHex, zeroPadValue, type Log } from "ethers";
import { commitmentHash, type SealedDomain } from "../../../agents/sealed/commitment";
import { SEALED_DEPLOYMENTS } from "./addresses";
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
  /** The round of this side's settled commitment. */
  commitIndex: number;
  /** The settled commitment. */
  commitment: string;
  /** The side's latest commit index. On v2 it can be one above `commitIndex` if the side committed ahead. */
  latestCommitIndex: number;
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
  /** Contract version, from the shape of getNegotiation: 1, or 2 with the commit freeze and policyHash. */
  contractVersion?: 1 | 2;
  /** v2 only: hash of the admission policy stored at creation. */
  policyHash?: string | null;
  blockNumber?: number;
  price?: bigint;
  buyer?: SettledSide;
  seller?: SettledSide;
}

export interface VerifyOptions {
  /** How far back from the settlement block to look for the settled commit transactions. Default 3000. */
  lookbackBlocks?: number;
  /** Blocks per eth_getLogs request. Monad's public RPC serves at most 100. */
  logChunk?: number;
}

type Role = "buyer" | "seller";
type CheckFn = (ok: boolean, label: string, detail?: string) => void;

// settle, commitOffer and the events read here are the same in v1 and v2.
const sealedInterface = new Interface(SEALED_NEGOTIATION_ABI);
const OFFER_COMMITTED = eventTopic("OfferCommitted(uint256,address,uint32)");
const SETTLED = sealedInterface.getEvent("NegotiationSettled")!;
const COMMIT_CALLDATA_BYTES = 68;
const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Checks a settlement against the chain alone, with no transcript and no key,
 * on a v1 or a v2 SealedNegotiation: decodes the settle calldata, recomputes
 * both commitments from the disclosed offers and salts, compares them with the
 * settled pair and with the commit transactions that put them there, recovers
 * both EIP-712 signers, and checks the NegotiationSettled event and the stored
 * price against the midpoint. The settled pair is both sides' latest
 * commitments on v1, and the last round both sides committed on v2.
 */
export async function verifySettlement(reader: SealedReader, txHash: string, options: VerifyOptions = {}): Promise<SettlementReport> {
  const checks: Check[] = [];
  const check: CheckFn = (ok, label, detail) => checks.push({ label, ok, ...(detail ? { detail } : {}) });
  const done = (extra: Partial<SettlementReport> = {}): SettlementReport => ({ txHash, ok: checks.every((c) => c.ok), checks, ...extra });

  const [tx, receipt] = await Promise.all([reader.provider.getTransaction(txHash), reader.provider.getTransactionReceipt(txHash)]);
  if (!tx || !receipt) {
    check(false, "transaction found on-chain");
    return done();
  }
  const call = safeParse(tx.data);
  const known = [reader.deployment, ...SEALED_DEPLOYMENTS].find((d) => sameAddress(d.sealedNegotiation, tx.to) && d.chainId === reader.deployment.chainId);
  check(receipt.status === 1, "transaction succeeded");
  check(!!known, "sent to a known SealedNegotiation deployment", known ? `v${known.version} at ${known.sealedNegotiation}` : `to ${tx.to}`);
  check(call?.name === "settle", "is a settle call", call ? `decoded ${call.name}` : "calldata is not a Sealed call");
  if (!call || call.name !== "settle" || !tx.to) return done({ blockNumber: receipt.blockNumber });

  const contract = getAddress(tx.to);
  const sealed = new Contract(contract, SEALED_NEGOTIATION_ABI, reader.provider);
  const negotiationId: bigint = call.args.negotiationId;
  const domain = await readDomain(reader, sealed, contract, check);
  const state = await reader.getNegotiation(negotiationId, contract);
  if (known) check(known.version === state.layout, `contract answers with the v${known.version} layout`, `v${state.layout}`);

  const reveal = (r: { offer: bigint; salt: string }) => ({ offer: r.offer, salt: r.salt });
  const sides = settledSides(state, { buyerReveal: reveal(call.args.buyerReveal), sellerReveal: reveal(call.args.sellerReveal) });
  await findCommitTransactions(reader, contract, state, sides, receipt.blockNumber, options);
  // v2: a side one round ahead has its settled commitment only in its commit transaction.
  for (const role of ["buyer", "seller"] as const) {
    const side = sides[role];
    if (side.commitIndex !== side.latestCommitIndex) side.commitment = (await commitmentOf(reader, side.commitTx)) ?? side.commitment;
  }

  for (const role of ["buyer", "seller"] as const) {
    const side = sides[role];
    const recomputed = commitmentHash({ domain, negotiationId, party: side.wallet, commitIndex: side.commitIndex, position: { offer: side.offer, salt: side.salt } });
    const onContract: string = await sealed.commitmentHash(negotiationId, side.wallet, side.commitIndex, side.offer, side.salt);
    const source = side.commitIndex === side.latestCommitIndex ? "stored" : `round ${side.commitIndex}, before it committed round ${side.latestCommitIndex}`;
    check(recomputed === side.commitment, `${role}: offer ${side.offer} with the disclosed salt hashes to its settled commitment #${side.commitIndex}`, `${source}: ${side.commitment}`);
    check(onContract === recomputed, `${role}: the contract's own commitmentHash agrees with the off-chain encoder`);
  }

  const digest = settleAuthorizationDigest(domain, {
    negotiationId,
    buyerCommitment: sides.buyer.commitment,
    sellerCommitment: sides.seller.commitment,
    buyerCommitIndex: sides.buyer.commitIndex,
    sellerCommitIndex: sides.seller.commitIndex,
  });
  const onChainDigest: string = await sealed.settleAuthorizationDigest(negotiationId);
  check(digest === onChainDigest, "EIP-712 SettleAuthorization digest over the settled pair matches the contract's");
  check(sameAddress(safeRecover(digest, call.args.buyerAuthorization), state.buyerWallet), "buyer's wallet signed the authorization for this commitment pair");
  check(sameAddress(safeRecover(digest, call.args.sellerAuthorization), state.sellerWallet), "seller's wallet signed the authorization for this commitment pair");

  const { buyer, seller } = sides;
  const price = seller.offer + (buyer.offer - seller.offer) / 2n;
  check(buyer.offer >= seller.offer, `offers cross: buyer ${buyer.offer} >= seller ${seller.offer}`);
  const event = receipt.logs.filter((l) => sameAddress(l.address, contract) && l.topics[0] === SETTLED.topicHash).map((l) => sealedInterface.parseLog(l))[0];
  check(!!event && event.args.negotiationId === negotiationId && event.args.price === price, `NegotiationSettled(${negotiationId}, ${price}) emitted: the midpoint`);
  check(state.status === "Settled" && state.settledPrice === price, `contract state: Settled at ${price}`, `${state.status} at ${state.settledPrice}`);

  await checkCommitTransactions(reader, state, sides, options, check);
  return done({ negotiationId, contract, contractVersion: state.layout, policyHash: state.policyHash, blockNumber: receipt.blockNumber, price, buyer, seller });
}

/** Which commitment of each side was settled: the latest on v1, the last complete round on v2. */
function settledSides(state: Negotiation, args: { buyerReveal: { offer: bigint; salt: string }; sellerReveal: { offer: bigint; salt: string } }): Record<Role, SettledSide> {
  const side = (role: Role): SettledSide => {
    const latest = role === "buyer" ? state.buyerCommitIndex : state.sellerCommitIndex;
    const reveal = role === "buyer" ? args.buyerReveal : args.sellerReveal;
    return {
      wallet: role === "buyer" ? state.buyerWallet : state.sellerWallet,
      agentId: role === "buyer" ? state.buyerAgentId : state.sellerAgentId,
      offer: reveal.offer,
      salt: reveal.salt,
      commitIndex: state.settleableRound ?? latest,
      commitment: role === "buyer" ? state.buyerCommitment : state.sellerCommitment,
      latestCommitIndex: latest,
      commitTx: null,
    };
  };
  return { buyer: side("buyer"), seller: side("seller") };
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

async function commitmentOf(reader: SealedReader, txHash: string | null): Promise<string | null> {
  if (!txHash) return null;
  const tx = await reader.provider.getTransaction(txHash);
  const parsed = tx && safeParse(tx.data);
  return parsed?.name === "commitOffer" ? parsed.args.commitment : null;
}

async function readDomain(reader: SealedReader, sealed: Contract, contract: string, check: CheckFn): Promise<SealedDomain> {
  const [, name, version, chainId, verifyingContract] = await sealed.eip712Domain();
  const network = await reader.provider.getNetwork();
  const ok = name === "Sealed" && version === "1" && chainId === network.chainId && sameAddress(verifyingContract, contract);
  check(ok, "EIP-712 domain is Sealed v1 on this chain and contract", `${name} ${version}, chain ${chainId}`);
  return { chainId, verifyingContract };
}

/**
 * Finds, by walking back from the settlement in chunks the public RPC accepts,
 * the commitOffer transactions of each side's settled round.
 */
async function findCommitTransactions(
  reader: SealedReader,
  contract: string,
  state: Negotiation,
  sides: Record<Role, SettledSide>,
  settleBlock: number,
  options: VerifyOptions,
) {
  const lookback = options.lookbackBlocks ?? 3000;
  const chunk = options.logChunk ?? 100;
  const wanted = new Map<string, Role>(
    (["buyer", "seller"] as const).map((role) => [`${sides[role].wallet.toLowerCase()}:${sides[role].commitIndex}`, role]),
  );
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
}

/** Each settled commitment came from a commit sent by its party, carrying the hash and nothing else. */
async function checkCommitTransactions(reader: SealedReader, state: Negotiation, sides: Record<Role, SettledSide>, options: VerifyOptions, check: CheckFn) {
  for (const role of ["buyer", "seller"] as const) {
    const side = sides[role];
    if (!side.commitTx) {
      check(false, `${role}: commit #${side.commitIndex} found within ${options.lookbackBlocks ?? 3000} blocks of the settlement`, "raise lookbackBlocks");
      continue;
    }
    const tx = await reader.provider.getTransaction(side.commitTx);
    const parsed = tx ? safeParse(tx.data) : null;
    check(
      !!tx && sameAddress(tx.from, side.wallet) && parsed?.name === "commitOffer" && parsed.args.commitment === side.commitment,
      `${role}: commit #${side.commitIndex} (${side.commitTx}) was sent by the ${role} and carried the settled hash`,
    );
    // commitOffer(uint256,bytes32) is 4 + 64 bytes. Anything longer could carry more than the hash.
    check(
      !!tx && dataLength(tx.data) === COMMIT_CALLDATA_BYTES && parsed?.args.negotiationId === state.negotiationId,
      `${role}: the commit calldata is only the negotiation id and the hash, so offer ${side.offer} is not in it`,
    );
  }
}
