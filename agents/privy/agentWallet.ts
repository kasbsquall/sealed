import { PrivyClient } from "@privy-io/node";
import { Interface, TypedDataEncoder, toQuantity, type Provider } from "ethers";
import {
  commitmentHash,
  settleAuthorizationTypedData,
  type Position,
  type SealedDomain,
  type SettleAuthorizationMessage,
} from "../sealed/commitment";
import { chainFees } from "../sealed/fees";
import { giveFeedbackArgs, reputationInterface, type DealFeedback } from "../sealed/dealFeedback";
import type { PartyWallet } from "../wallets/partyWallet";

const SEALED_ABI = [
  "function commitOffer(uint256 negotiationId, bytes32 commitment)",
  "function settle(uint256 negotiationId, (uint256 offer, bytes32 salt) buyerReveal, (uint256 offer, bytes32 salt) sellerReveal, bytes buyerAuthorization, bytes sellerAuthorization) returns (uint256)",
  "function expire(uint256 negotiationId)",
];

const sealedInterface = new Interface(SEALED_ABI);
const identityInterface = new Interface(["function register(string agentURI) returns (uint256)"]);

export interface AgentWalletConfig {
  privy: PrivyClient;
  /** Privy wallet id, from `provisionAgentWallet`. */
  walletId: string;
  /** The wallet's EVM address, which is what the contract checks. */
  address: string;
  /** Deployed SealedNegotiation address and Monad chain id. */
  domain: SealedDomain;
  /** Base64 PKCS8 authorization key that lets this backend act for the wallet. */
  authorizationPrivateKey: string;
  /** Used to estimate gas, price fees and wait for receipts. Strongly recommended. */
  provider?: Provider;
  /**
   * Who puts the signed transaction on the network.
   *
   * "privy" (default): Privy signs and broadcasts, via eth_sendTransaction.
   * "self": Privy signs inside its enclave via eth_signTransaction, and this
   * process broadcasts the signed bytes through `provider`. For chains where
   * Privy signs but does not broadcast. The mandate carries identical rules for
   * both methods, so the agent is exactly as bounded either way.
   */
  broadcast?: "privy" | "self";
}

/**
 * Provisions a wallet for a negotiator agent.
 *
 * The wallet is owned by an admin key quorum (`ownerId`) the agent does not
 * hold. The agent's own quorum (`signerId`) is only an additional signer, held
 * to the Sealed mandate, so the agent can sign negotiations but cannot change
 * its mandate, take the wallet back or export it. The wallet is created already
 * in that shape: there is no moment in its life where it is unconstrained.
 */
export async function provisionAgentWallet(
  privy: PrivyClient,
  params: { ownerId: string; signerId: string; policyId: string; displayName: string; externalId?: string },
) {
  return privy.wallets().create({
    chain_type: "ethereum",
    owner_id: params.ownerId,
    additional_signers: [{ signer_id: params.signerId, override_policy_ids: [params.policyId] }],
    policy_ids: [params.policyId],
    display_name: params.displayName,
    external_id: params.externalId,
  });
}

/**
 * An agent's hands. Everything the negotiator decides goes through here, and
 * nothing here ever asks a human for permission.
 *
 * Note what this class never does: it never accepts a raw transaction from the
 * caller, and it never exposes a generic "sign this" method. Every method
 * builds its own calldata or its own typed data from Sealed's own encoders. The
 * Privy policy enforces the same restriction independently, so a bug here is
 * caught there.
 */
/** Attempts at a broadcast Privy refuses for a balance it has not caught up with yet. */
const BALANCE_RETRIES = 6;

export class AgentWallet implements PartyWallet {
  constructor(private readonly config: AgentWalletConfig) {}

  get address(): string {
    return this.config.address;
  }

  private get authorizationContext() {
    return { authorization_private_keys: [this.config.authorizationPrivateKey] };
  }

  private get caip2(): `eip155:${string}` {
    return `eip155:${this.config.domain.chainId}`;
  }

  /**
   * Sends calldata this class built itself, and waits for it to land. With a
   * provider, gas is estimated with headroom and fees follow the latest block:
   * both parties usually commit in the same block, and whichever lands second
   * also flips the negotiation to Locked, which costs more than its estimate saw.
   */
  private async send(to: string, data: string): Promise<string> {
    const { provider } = this.config;
    const extra: { gas_limit?: string; max_fee_per_gas?: string; max_priority_fee_per_gas?: string } = {};
    if (provider) {
      const estimate = await provider.estimateGas({ from: this.config.address, to, data });
      const fees = await chainFees(provider);
      extra.gas_limit = toQuantity((estimate * 3n) / 2n);
      extra.max_fee_per_gas = toQuantity(fees.maxFeePerGas);
      extra.max_priority_fee_per_gas = toQuantity(fees.maxPriorityFeePerGas);
    }
    const transaction = { to, value: "0x0", data, chain_id: Number(this.config.domain.chainId), ...extra };

    const hash = this.config.broadcast === "self" ? await this.signAndBroadcast(transaction) : await this.sendViaPrivy(transaction);

    if (provider) {
      const receipt = await waitForReceipt(provider, hash);
      if (receipt.status !== 1) throw new Error(`transaction failed: ${hash}`);
    }
    return hash;
  }

  /**
   * Right after a wallet is funded, Privy's node can still report the old
   * balance and refuse to broadcast. That one error is retried briefly; any
   * other refusal, a policy violation above all, surfaces at once.
   */
  private async sendViaPrivy(transaction: Record<string, unknown>): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { hash } = await this.config.privy.wallets().ethereum().sendTransaction(this.config.walletId, {
          caip2: this.caip2,
          params: { transaction },
          authorization_context: this.authorizationContext,
        });
        return hash;
      } catch (error) {
        const stale = /insufficient balance/i.test(String((error as Error).message));
        if (!stale || attempt >= BALANCE_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Privy signs under the mandate; this process only relays the signed bytes.
   * A transaction the policy refuses is never signed, so there is nothing to
   * broadcast: the refusal surfaces here exactly as it would on the Privy path.
   */
  private async signAndBroadcast(transaction: Record<string, unknown>): Promise<string> {
    const { provider } = this.config;
    if (!provider) throw new Error('broadcast "self" needs a provider');
    if (!transaction.gas_limit) throw new Error('broadcast "self" needs gas and fees, which come from the provider');
    const nonce = await provider.getTransactionCount(this.config.address, "pending");
    const { signed_transaction } = await this.config.privy.wallets().ethereum().signTransaction(this.config.walletId, {
      params: { transaction: { ...transaction, type: 2, nonce: toQuantity(nonce) } },
      authorization_context: this.authorizationContext,
    });
    const sent = await provider.broadcastTransaction(signed_transaction);
    return sent.hash;
  }

  /**
   * Creates this agent's ERC-8004 identity. The registry records the caller as
   * the agent's wallet, so the Privy wallet becomes the agent without ever
   * signing anything outside its mandate.
   */
  /**
   * Rates the counterparty of a settled deal. The mandate allows this one
   * function on the Reputation Registry and nothing else there.
   */
  async giveFeedback(reputationRegistry: string, feedback: DealFeedback): Promise<string> {
    return this.send(reputationRegistry, reputationInterface.encodeFunctionData("giveFeedback", giveFeedbackArgs(feedback)));
  }

  async registerAgent(identityRegistry: string, agentURI: string): Promise<string> {
    return this.send(identityRegistry, identityInterface.encodeFunctionData("register", [agentURI]));
  }

  /**
   * Locks in a position. The offer and the salt stay in this process; what goes
   * on-chain is a hash the agent computed itself.
   */
  async commit(negotiationId: bigint, commitIndex: number, position: Position): Promise<string> {
    const commitment = commitmentHash({
      domain: this.config.domain,
      negotiationId,
      party: this.config.address,
      commitIndex,
      position,
    });
    return this.send(this.config.domain.verifyingContract, sealedInterface.encodeFunctionData("commitOffer", [negotiationId, commitment]));
  }

  /**
   * Authorizes settlement of one exact pair of commitments.
   *
   * This signature is what makes settlement atomic. It is worthless on its own:
   * the contract needs both parties' signatures over the same pair. In the
   * deployed contract any new commitment by either side voids it; from v2 on it
   * is void once both sides have committed a new round, and one side alone
   * cannot void it.
   */
  async authorizeSettlement(message: SettleAuthorizationMessage): Promise<string> {
    const typedData = settleAuthorizationTypedData(this.config.domain, message);

    const { signature } = await this.config.privy.wallets().ethereum().signTypedData(this.config.walletId, {
      params: {
        typed_data: {
          // The request is JSON: a bigint chain id would make the SDK throw.
          domain: { ...typedData.domain, chainId: Number(typedData.domain.chainId) },
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            ...TypedDataEncoder.from(typedData.types as any).types,
          },
          primary_type: "SettleAuthorization",
          message: {
            negotiationId: message.negotiationId.toString(),
            buyerCommitment: message.buyerCommitment,
            sellerCommitment: message.sellerCommitment,
            buyerCommitIndex: message.buyerCommitIndex,
            sellerCommitIndex: message.sellerCommitIndex,
          },
        },
      },
      authorization_context: this.authorizationContext,
    });

    return signature;
  }

  /**
   * Submits the settlement. Either agent can do this, or a relayer; it carries
   * both positions and both authorizations, so there is no advantage in being
   * the one who sends it.
   */
  async settle(args: {
    negotiationId: bigint;
    buyerReveal: Position;
    sellerReveal: Position;
    buyerAuthorization: string;
    sellerAuthorization: string;
  }): Promise<string> {
    const data = sealedInterface.encodeFunctionData("settle", [
      args.negotiationId,
      [args.buyerReveal.offer, args.buyerReveal.salt],
      [args.sellerReveal.offer, args.sellerReveal.salt],
      args.buyerAuthorization,
      args.sellerAuthorization,
    ]);
    return this.send(this.config.domain.verifyingContract, data);
  }

  /** Closes a negotiation that ran out of time, disclosing nothing. */
  async expire(negotiationId: bigint): Promise<string> {
    return this.send(this.config.domain.verifyingContract, sealedInterface.encodeFunctionData("expire", [negotiationId]));
  }
}

/**
 * Polls for a receipt. Hardhat's provider does not implement waitForTransaction,
 * and a transaction Privy broadcast can take a moment to reach the node we read.
 */
async function waitForReceipt(provider: Provider, hash: string, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`no receipt for ${hash} after ${timeoutMs / 1000} s`);
}
