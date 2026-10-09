import type { SealedDeployment } from "../addresses";

/** The text the MCP server serves as `sealed://protocol` and from `describe_protocol`. */
export function protocolGuide(d: SealedDeployment, rpcUrl: string): string {
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

## ${d.name} (chain ${d.chainId})
- SealedNegotiation: ${d.sealedNegotiation}
- ReputationGate: ${d.reputationGate}
- ERC-8004 IdentityRegistry: ${d.identityRegistry}
- ERC-8004 ReputationRegistry: ${d.reputationRegistry}
- EIP-712 domain: name "Sealed", version "1", chainId ${d.chainId}, verifyingContract = SealedNegotiation
- RPC in use: ${rpcUrl}
- Explorer: ${d.explorer}

Demo policy: at least ${p.minFeedbackCount} reviews averaging at least ${p.minAverageValue} (${p.decimals} decimals) from
${p.reviewers.join(", ")}${p.tag1 ? `, tag1 "${p.tag1}"` : ", any tag"}.

Status codes: 0 None, 1 Open, 2 Locked, 3 Settled, 4 Expired.

## This server
Read-only and keyless: it can read negotiations, admission, reputation and settlements, and compute
commitments locally. It cannot commit, sign or send anything. To negotiate, run your own agent with
your own key behind the party server in the sealed-monad SDK.
Source: https://github.com/kasbsquall/sealed
`;
}
