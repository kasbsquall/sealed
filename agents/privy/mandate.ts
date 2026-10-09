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
  /** Monad chain id. 10143 for testnet, 143 for mainnet. */
  chainId: number;
  /** Key quorum that owns the policy, from the Privy dashboard. */
  ownerId: string;
  /** Label shown in the Privy dashboard. */
  name?: string;
  /**
   * ERC-8004 Identity Registry. When given, the wallet may also call
   * `register` there, and only `register`, so an agent can create its own
   * identity. The registry records the caller as the agent's wallet, which is
   * how the wallet becomes an ERC-8004 agent without ever being unconstrained.
   */
  identityRegistry?: string;
}

const REGISTER_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ internalType: "string", name: "agentURI", type: "string" }],
    outputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
  },
];

/** Methods that put a transaction on chain. Both get identical rules: see AgentWallet `broadcast`. */
const TRANSACTION_METHODS = ["eth_sendTransaction", "eth_signTransaction"] as const;

/** Pins destination, chain and attached value of a transaction. */
function transactionConditions(to: string, chainId: number) {
  return [
    { field_source: "ethereum_transaction" as const, field: "to" as const, operator: "eq" as const, value: to.toLowerCase() },
    { field_source: "ethereum_transaction" as const, field: "chain_id" as const, operator: "eq" as const, value: String(chainId) },
    // A negotiation never moves value, so the wallet may not attach any.
    { field_source: "ethereum_transaction" as const, field: "value" as const, operator: "eq" as const, value: "0x0" },
  ];
}

/**
 * The rules of the mandate, as data. Pure, so tests can check exactly what an
 * agent is and is not allowed to do without calling Privy.
 *
 * Every rule is ALLOW; Privy denies anything no rule matches.
 */
export function buildMandateRules(config: Omit<MandateConfig, "ownerId" | "name">) {
  const sealedAddress = config.sealedAddress.toLowerCase();
  const rules = [];

  for (const method of TRANSACTION_METHODS) {
    // Transactions: only ever to the Sealed contract. This covers commitOffer,
    // settle and expire, and nothing else exists at that address to call.
    rules.push({
      name: `Sealed contract only (${method})`,
      method,
      action: "ALLOW" as const,
      conditions: transactionConditions(sealedAddress, config.chainId),
    });
    if (config.identityRegistry) {
      // And `register` on the ERC-8004 Identity Registry, nothing else there.
      rules.push({
        name: `ERC-8004 register only (${method})`,
        method,
        action: "ALLOW" as const,
        conditions: [
          ...transactionConditions(config.identityRegistry, config.chainId),
          {
            field_source: "ethereum_calldata" as const,
            field: "function_name",
            abi: REGISTER_ABI,
            operator: "eq" as const,
            value: "register",
          },
        ],
      });
    }
  }

  // Signatures: only ever a Sealed settlement authorization. Without this rule
  // an agent could be talked into signing a permit or an order for an
  // unrelated protocol, which is the usual way an autonomous signer gets
  // drained, and no transaction rule would stop it because the damage lands
  // later. The domain separator is the defence, and the policy enforces it
  // before the enclave ever sees the payload.
  rules.push({
    name: "Sealed EIP-712 payloads only",
    method: "eth_signTypedData_v4" as const,
    action: "ALLOW" as const,
    conditions: [
      { field_source: "ethereum_typed_data_domain" as const, field: "verifyingContract" as const, operator: "eq" as const, value: sealedAddress },
      { field_source: "ethereum_typed_data_domain" as const, field: "chainId" as const, operator: "eq" as const, value: String(config.chainId) },
    ],
  });

  return rules;
}

/**
 * Creates the policy. Run once per deployment; reuse the returned id across the
 * whole agent fleet so every negotiator carries identical constraints.
 */
export async function createSealedMandate(privy: PrivyClient, config: MandateConfig) {
  return privy.policies().create({
    name: config.name ?? `Sealed negotiator mandate (${config.chainId})`,
    version: "1.0",
    chain_type: "ethereum",
    owner_id: config.ownerId,
    rules: buildMandateRules(config),
  });
}

/**
 * Narrowing this further is possible and worth doing before any real value
 * rides on it: the `ethereum_calldata` condition already used for `register`
 * can pin every Sealed function selector the same way, and bound arguments.
 * The rules above are the floor, not the ceiling.
 */
