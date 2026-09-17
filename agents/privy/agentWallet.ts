import { PrivyClient } from "@privy-io/node";
import { Interface, JsonRpcProvider, TypedDataEncoder } from "ethers";
import {
  commitmentHash,
  settleAuthorizationTypedData,
  type Position,
  type SealedDomain,
  type SettleAuthorizationMessage,
} from "../sealed/commitment";

const SEALED_ABI = [
  "function commitOffer(uint256 negotiationId, bytes32 commitment)",
  "function settle(uint256 negotiationId, (uint256 offer, bytes32 salt) buyerReveal, (uint256 offer, bytes32 salt) sellerReveal, bytes buyerAuthorization, bytes sellerAuthorization) returns (uint256)",
  "function expire(uint256 negotiationId)",
];

const sealedInterface = new Interface(SEALED_ABI);

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
  provider?: JsonRpcProvider;
}

/**
 * Provisions a wallet for a negotiator agent.
 *
 * The wallet is owned by a key quorum held by this backend, not by a human
 * user, and it is created already bound to the Sealed mandate. There is no
 * moment in its life where it is unconstrained.
 */
export async function provisionAgentWallet(
  privy: PrivyClient,
  params: { ownerId: string; policyId: string; displayName: string; externalId?: string },
) {
  return privy.wallets().create({
    chain_type: "ethereum",
    owner_id: params.ownerId,
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
export class AgentWallet {
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

    const data = sealedInterface.encodeFunctionData("commitOffer", [negotiationId, commitment]);

    const { hash } = await this.config.privy.wallets().ethereum().sendTransaction(this.config.walletId, {
      caip2: this.caip2,
      params: {
        transaction: {
          to: this.config.domain.verifyingContract,
          value: "0x0",
          data,
          chain_id: Number(this.config.domain.chainId),
        },
      },
      authorization_context: this.authorizationContext,
    });

    return hash;
  }

  /**
   * Authorizes settlement of one exact pair of commitments.
   *
   * This signature is what makes settlement atomic. It is worthless on its own:
   * the contract needs both parties' signatures over the same pair, and any new
   * commitment by either side changes the message and voids it.
   */
  async authorizeSettlement(message: SettleAuthorizationMessage): Promise<string> {
    const typedData = settleAuthorizationTypedData(this.config.domain, message);

    const { signature } = await this.config.privy.wallets().ethereum().signTypedData(this.config.walletId, {
      params: {
        typed_data: {
          domain: typedData.domain,
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

    const { hash } = await this.config.privy.wallets().ethereum().sendTransaction(this.config.walletId, {
      caip2: this.caip2,
      params: {
        transaction: {
          to: this.config.domain.verifyingContract,
          value: "0x0",
          data,
          chain_id: Number(this.config.domain.chainId),
        },
      },
      authorization_context: this.authorizationContext,
    });

    return hash;
  }

  /** Closes a negotiation that ran out of time, disclosing nothing. */
  async expire(negotiationId: bigint): Promise<string> {
    const data = sealedInterface.encodeFunctionData("expire", [negotiationId]);

    const { hash } = await this.config.privy.wallets().ethereum().sendTransaction(this.config.walletId, {
      caip2: this.caip2,
      params: {
        transaction: {
          to: this.config.domain.verifyingContract,
          value: "0x0",
          data,
          chain_id: Number(this.config.domain.chainId),
        },
      },
      authorization_context: this.authorizationContext,
    });

    return hash;
  }
}
