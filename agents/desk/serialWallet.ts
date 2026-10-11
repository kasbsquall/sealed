import { Wallet, type TransactionRequest, type TransactionResponse } from "ethers";

/**
 * A Wallet that sends one transaction at a time and counts its own nonce. At
 * the desk one wallet submits both sides' commitments, which the relay sends in
 * parallel, and Monad's public RPC is load-balanced: asking it for the pending
 * nonce right after a send can land on a node that has not seen that send yet.
 * A send that fails before broadcast forgets the count, so the next one asks
 * the chain again.
 */
export class SerialWallet extends Wallet {
  private nextNonce?: number;
  private lock: Promise<unknown> = Promise.resolve();

  override sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const run = async () => {
      this.nextNonce ??= await this.getNonce("pending");
      try {
        const sent = await super.sendTransaction({ ...tx, nonce: this.nextNonce });
        this.nextNonce += 1;
        return sent;
      } catch (error) {
        this.nextNonce = undefined;
        throw error;
      }
    };
    const result = this.lock.then(run, run);
    this.lock = result.catch(() => undefined);
    return result;
  }
}
