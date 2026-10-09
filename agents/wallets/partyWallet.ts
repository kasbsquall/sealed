import { Contract, type BaseWallet } from "ethers";
import {
  commitmentHash,
  settleAuthorizationTypedData,
  type Position,
  type SealedDomain,
  type SettleAuthorizationMessage,
} from "../sealed/commitment";
import { chainFees } from "../sealed/fees";

/**
 * What a negotiator needs from its wallet, and nothing more: commit a hash and
 * sign a settlement authorization. Opening, settling and expiring are done by
 * the relay, so an agent's key never has to be able to do anything else.
 *
 * `AgentWallet` in agents/privy/agentWallet.ts satisfies this interface with a
 * Privy server wallet under the Sealed mandate. `LocalPartyWallet` below is the
 * same thing with a local key, used by the demo and the tests.
 */
export interface PartyWallet {
  readonly address: string;
  commit(negotiationId: bigint, commitIndex: number, position: Position): Promise<string>;
  authorizeSettlement(message: SettleAuthorizationMessage): Promise<string>;
}

const COMMIT_ABI = ["function commitOffer(uint256 negotiationId, bytes32 commitment)"];

export class LocalPartyWallet implements PartyWallet {
  private readonly sealed: Contract;

  constructor(
    private readonly wallet: BaseWallet,
    private readonly domain: SealedDomain,
  ) {
    this.sealed = new Contract(domain.verifyingContract, COMMIT_ABI, wallet);
  }

  get address() {
    return this.wallet.address;
  }

  async commit(negotiationId: bigint, commitIndex: number, position: Position): Promise<string> {
    const commitment = commitmentHash({ domain: this.domain, negotiationId, party: this.address, commitIndex, position });
    // Both parties usually commit in the same block. Whichever lands second also
    // flips the negotiation to Locked, which costs more than its estimate saw, so
    // the estimate gets headroom.
    const estimate = await this.sealed.commitOffer.estimateGas(negotiationId, commitment);
    const tx = await this.sealed.commitOffer(negotiationId, commitment, {
      ...(await chainFees(this.wallet.provider!)),
      gasLimit: (estimate * 3n) / 2n,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`commitOffer failed: ${tx.hash}`);
    return tx.hash;
  }

  async authorizeSettlement(message: SettleAuthorizationMessage): Promise<string> {
    const typed = settleAuthorizationTypedData(this.domain, message);
    return this.wallet.signTypedData(typed.domain, { SettleAuthorization: [...typed.types.SettleAuthorization] }, typed.message);
  }
}
