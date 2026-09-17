import { PrivyClient } from "@privy-io/node";

/**
 * The mandate: a Privy policy that bounds what an agent's wallet is physically
 * able to do.
 *
 * This is the part of Sealed that makes an autonomous negotiator safe to run.
 * The agent decides its own positions, signs its own transactions, and never
 * asks a human to approve anything. In exchange, the key it signs with is
 * constrained at the infrastructure level, not by the agent's own good
 * behaviour:
 *
 *   - it can only send transactions to the Sealed contract, on Monad, and
 *   - it can only sign EIP-712 payloads whose domain is that same contract on
 *     that same chain.
 *
 * Every rule is ALLOW; Privy denies anything no rule matches. So a negotiator
 * whose model is jailbroken, whose prompt is poisoned, or whose process is
 * compromised still cannot transfer a single token anywhere, cannot approve a
 * spender, and cannot sign a permit for some unrelated protocol. The worst it
 * can do is negotiate badly.
 *
 * The private key never leaves Privy's enclave. Our backend holds an
 * authorization key that lets it request signatures, not the key itself.
 */

export interface MandateConfig {
  /** Deployed SealedNegotiation address. */
  sealedAddress: string;
  /** Monad chain id. 10143 for testnet. */
  chainId: number;
  /** Key quorum that owns the policy, from the Privy dashboard. */
  ownerId: string;
  /** Label shown in the Privy dashboard. */
  name?: string;
}

/**
 * Creates the policy. Run once per deployment; reuse the returned id across the
 * whole agent fleet so every negotiator carries identical constraints.
 */
export async function createSealedMandate(privy: PrivyClient, config: MandateConfig) {
  const sealedAddress = config.sealedAddress.toLowerCase();

  return privy.policies().create({
    name: config.name ?? `Sealed negotiator mandate (${config.chainId})`,
    version: "1.0",
    chain_type: "ethereum",
    owner_id: config.ownerId,
    rules: [
      {
        // Transactions: only ever to the Sealed contract. This covers
        // commitOffer, settle and expire, and nothing else exists at that
        // address to call.
        name: "Only transact with SealedNegotiation",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          {
            field_source: "ethereum_transaction",
            field: "to",
            operator: "eq",
            value: sealedAddress,
          },
          {
            field_source: "ethereum_transaction",
            field: "chain_id",
            operator: "eq",
            value: String(config.chainId),
          },
          {
            // A negotiation never moves value through the contract, so the
            // wallet is not permitted to attach any.
            field_source: "ethereum_transaction",
            field: "value",
            operator: "eq",
            value: "0x0",
          },
        ],
      },
      {
        // Signatures: only ever a Sealed settlement authorization. Without this
        // rule an agent could be tricked into signing a permit or an order for
        // an unrelated protocol, which is the usual way an autonomous signer
        // gets drained. The domain separator is the defence, and the policy
        // enforces it before the enclave ever sees the payload.
        name: "Only sign Sealed EIP-712 payloads",
        method: "eth_signTypedData_v4",
        action: "ALLOW",
        conditions: [
          {
            field_source: "ethereum_typed_data_domain",
            field: "verifyingContract",
            operator: "eq",
            value: sealedAddress,
          },
          {
            field_source: "ethereum_typed_data_domain",
            field: "chainId",
            operator: "eq",
            value: String(config.chainId),
          },
        ],
      },
    ],
  });
}

/**
 * Narrowing this further is possible and worth doing before any real value
 * rides on it: Privy supports `field_source: 'ethereum_calldata'` with a
 * Solidity ABI, which allows pinning the exact function selectors an agent may
 * call and bounding the arguments it may pass. The two rules above are the
 * floor, not the ceiling.
 */
