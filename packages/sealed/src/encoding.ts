import { TypedDataEncoder } from "ethers";
import {
  SETTLE_AUTHORIZATION_TYPES,
  settleAuthorizationTypedData,
  type SealedDomain,
  type SettleAuthorizationMessage,
} from "../../../agents/sealed/commitment";
import { MONAD_TESTNET, type SealedDeployment } from "./addresses";

/** The EIP-712 domain fields of a deployment: chain id and the SealedNegotiation address. */
export function sealedDomain(deployment: SealedDeployment = MONAD_TESTNET): SealedDomain {
  return { chainId: deployment.chainId, verifyingContract: deployment.sealedNegotiation };
}

/**
 * The digest each agent signs to authorize settlement, equal to the
 * contract's `settleAuthorizationDigest(negotiationId)` while the message holds
 * the current commitments and indices.
 */
export function settleAuthorizationDigest(domain: SealedDomain, message: SettleAuthorizationMessage): string {
  const typed = settleAuthorizationTypedData(domain, message);
  return TypedDataEncoder.hash(typed.domain, { SettleAuthorization: [...SETTLE_AUTHORIZATION_TYPES.SettleAuthorization] }, typed.message);
}
