import { MONAD_TESTNET_V3, type SealedDeployment } from "../addresses";

/** The text the MCP server serves as `sealed://protocol` and from `describe_protocol`. */
export function protocolGuide(deployments: readonly SealedDeployment[], rpcUrl: string): string {
  const [d] = deployments;
  const p = d.demoPolicy;
  return `# Sealed

Two AI agents agree a price without either seeing the other's limit first.

## Flow
1. createNegotiation(buyerAgentId, buyerWallet, sellerAgentId, sellerWallet, deadline, termsSchema, policy).
   ReputationGate admits each agent only if its wallet is the one ERC-8004 has on record
   and its reputation, counted over the policy's trusted reviewers, clears the policy.
2. Each round, each side calls commitOffer(negotiationId, commitment). Only a hash goes on-chain:
   commitment = keccak256(abi.encode(domainSeparator, negotiationId, party, commitIndex, offer, salt)),
   with a fresh 32-byte salt every round. commitIndex starts at 1 and grows by one per commit.
3. A clearing relay checks each reveal against its on-chain hash and tells both sides one bit:
   crossed or not. Before comparing, it collects both EIP-712 SettleAuthorization signatures
   over (negotiationId, buyerCommitment, sellerCommitment, buyerCommitIndex, sellerCommitIndex).
4. If buyer offer >= seller offer, one settle() call discloses both offers and salts with both
   signatures and settles at the midpoint: seller + (buyer - seller) / 2.
5. If they never cross, anyone calls expire() after the deadline. No offer is ever published.

The relay is trusted with confidentiality (it sees both numbers of a round), never with the deal:
it cannot settle without both signatures over the exact committed pair.

## Versions
- v2 (current): each side commits once per round and may be at most one round ahead; a second commit
  before the other side catches up reverts with AlreadyCommitted(index). settle takes the last round both
  sides committed, and the authorization signs that round as both indices. getNegotiation and
  NegotiationCreated carry policyHash = keccak256(abi.encode(policy)); admissionPolicyHash(policy) computes it.
- v1: any re-commit replaces a side's commitment and bumps its index; the authorization covers both
  latest indices. The published demo negotiations #1 to #10 live here.
- v3 (${MONAD_TESTNET_V3.sealedNegotiation}): v2's negotiation, paid at settlement. Both parties sign
  EIP-712 OpenNegotiation terms (agents, deadline, terms, policy hash, token, scale) before it opens.
  settle() moves price * scale of the token from the buyer's escrow to the seller, less a ${MONAD_TESTNET_V3.feeBps / 100}% fee,
  in the same transaction. commitOfferBySig lets a relay submit a party's signed commitment, so a party
  needs no gas. Payment token on testnet: SealedTestUSD ${MONAD_TESTNET_V3.testUsd}, no value.

## Monad testnet (chain ${d.chainId})
${deployments.map((x) => `- v${x.version} SealedNegotiation: ${x.sealedNegotiation}, ReputationGate: ${x.reputationGate}`).join("\n")}
- ERC-8004 IdentityRegistry: ${d.identityRegistry}
- ERC-8004 ReputationRegistry: ${d.reputationRegistry}
- EIP-712 domain: name "Sealed", version "1", chainId ${d.chainId}, verifyingContract = the SealedNegotiation
- RPC in use: ${rpcUrl}
- Explorer: ${d.explorer}

Demo policy: at least ${p.minFeedbackCount} reviews averaging at least ${p.minAverageValue} (${p.decimals} decimals) from
${p.reviewers.join(", ")}${p.tag1 ? `, tag1 "${p.tag1}"` : ", any tag"}.

Status codes: 0 None, 1 Open, 2 Locked, 3 Settled, 4 Expired.

## This server
The read tools are keyless: they read negotiations, admission, reputation and settlements, and compute
commitments locally.

The desk tools (desk_info, desk_open_negotiation, desk_submit_offer, desk_status) negotiate as a buyer at
the public Sealed desk on v3. They sign with a testnet guest key this server creates in ~/.sealed; the key
never holds MON, because the desk pays every fee. Your limit stays in this process and every offer is
checked against it: a settlement publishes both offers, so an offer equal to the limit is refused. Before revealing an offer, the server reads the chain itself and waits until both
commitments of the round are on-chain. The desk runs the relay and the seller, so it sees both numbers
of each round, as any relay does; it cannot settle or move funds without your signature.
Source: https://github.com/kasbsquall/sealed
`;
}
