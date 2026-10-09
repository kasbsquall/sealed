/**
 * sealed-monad: the SDK. Everything here is built from the reference code in
 * the Sealed repository (agents/sealed, agents/relay), bundled so the package
 * stands alone.
 *
 *  - Commitments and settlement authorizations, byte-for-byte what the
 *    contract computes.
 *  - ABIs and the Monad testnet addresses.
 *  - A read-only client: negotiations, admission, reputation, settlement checks.
 *  - The HTTP party server, to join a negotiation through the clearing relay
 *    with your own agent and your own key.
 */

export {
  SEALED_EIP712_DOMAIN_NAME,
  SEALED_EIP712_DOMAIN_VERSION,
  SETTLE_AUTHORIZATION_TYPES,
  assertSalt,
  commitmentHash,
  domainSeparator,
  newSalt,
  settleAuthorizationTypedData,
  type Position,
  type SealedDomain,
  type SettleAuthorizationMessage,
} from "../../../agents/sealed/commitment";
export { admissionPolicyHash, sealedDomain, settleAuthorizationDigest } from "./encoding";

export { MONAD_TESTNET, MONAD_TESTNET_V1, MONAD_TESTNET_V2, SEALED_DEPLOYMENTS, type Policy, type SealedDeployment } from "./addresses";
export { IDENTITY_REGISTRY_ABI, REPUTATION_GATE_ABI, REPUTATION_REGISTRY_ABI, SEALED_NEGOTIATION_ABI, SEALED_NEGOTIATION_V1_ABI } from "./abis";

export {
  NEGOTIATION_STATUSES,
  SealedReader,
  createReadClient,
  decodeNegotiation,
  type AdmissionResult,
  type Negotiation,
  type NegotiationStatus,
  type ReadClientOptions,
  type ReputationSummary,
} from "./read";
export { verifySettlement, type Check, type SettledSide, type SettlementReport, type VerifyOptions } from "./verify";

export { HttpParty, partyHandler, serveParty, serverUrl, type Party } from "../../../agents/relay/party";
export { STANCES } from "../../../agents/negotiator/tools";
export type { AgentStep, Decision, Reveal, Stance } from "../../../agents/negotiator/negotiator";
