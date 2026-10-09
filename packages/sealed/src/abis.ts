/**
 * Human-readable ABIs. ethers takes them as they are (`new Interface(abi)`),
 * viem through `parseAbi(abi)`. The v2 Sealed contracts are listed in full and
 * checked against the compiled artifacts by test/sdk.test.ts at the repo root;
 * the v1 ABI is the one published in 0.1.0, checked then against the v1
 * artifacts. The ERC-8004 registries only expose the parts Sealed reads or writes.
 */

const POLICY_TUPLE = "(address[] reviewers, uint64 minFeedbackCount, int128 minAverageValue, uint8 decimals, string tag1)";
const REVEAL_TUPLE = "(uint256 offer, bytes32 salt)";
const NEGOTIATION_V1_FIELDS =
  "address buyerWallet, address sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, bytes32 buyerCommitment, bytes32 sellerCommitment, uint32 buyerCommitIndex, uint32 sellerCommitIndex, uint64 deadline, uint8 status, uint256 settledPrice, bytes32 termsSchema";
const CREATED_V1_FIELDS =
  "uint256 indexed negotiationId, address indexed buyerWallet, address indexed sellerWallet, uint256 buyerAgentId, uint256 sellerAgentId, uint64 deadline, bytes32 termsSchema";

/** Entries both versions share. */
const SEALED_COMMON = [
  "constructor(address gate)",
  `function createNegotiation(uint256 buyerAgentId, address buyerWallet, uint256 sellerAgentId, address sellerWallet, uint64 deadline, bytes32 termsSchema, ${POLICY_TUPLE} policy) returns (uint256 negotiationId)`,
  "function commitOffer(uint256 negotiationId, bytes32 commitment)",
  `function settle(uint256 negotiationId, ${REVEAL_TUPLE} buyerReveal, ${REVEAL_TUPLE} sellerReveal, bytes buyerAuthorization, bytes sellerAuthorization) returns (uint256 price)`,
  "function expire(uint256 negotiationId)",
  "function commitmentHash(uint256 negotiationId, address party, uint32 commitIndex, uint256 offer, bytes32 salt) view returns (bytes32)",
  "function settleAuthorizationDigest(uint256 negotiationId) view returns (bytes32)",
  "function negotiationCount() view returns (uint256)",
  "function gate() view returns (address)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "event OfferCommitted(uint256 indexed negotiationId, address indexed party, uint32 commitIndex)",
  "event NegotiationLocked(uint256 indexed negotiationId)",
  "event NegotiationSettled(uint256 indexed negotiationId, uint256 price)",
  "event NegotiationExpired(uint256 indexed negotiationId)",
  "event EIP712DomainChanged()",
  "error UnknownNegotiation(uint256 negotiationId)",
  "error WrongStatus(uint8 found, uint8 required)",
  "error NotAParty(address caller)",
  "error SameParty()",
  "error DeadlinePassed()",
  "error DeadlineNotPassed()",
  "error DeadlineTooSoon()",
  "error CommitmentMismatch(address party)",
  "error BadAuthorization(address party)",
  "error IncompatibleOffers()",
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256 length)",
  "error ECDSAInvalidSignatureS(bytes32 s)",
  "error InvalidShortString()",
  "error StringTooLong(string str)",
] as const;

/** SealedNegotiation v2, the current deployment. */
export const SEALED_NEGOTIATION_ABI = [
  ...SEALED_COMMON,
  `function getNegotiation(uint256 negotiationId) view returns ((${NEGOTIATION_V1_FIELDS}, bytes32 policyHash))`,
  `function admissionPolicyHash(${POLICY_TUPLE} policy) pure returns (bytes32)`,
  `event NegotiationCreated(${CREATED_V1_FIELDS}, bytes32 policyHash)`,
  "error AlreadyCommitted(uint32 commitIndex)",
] as const;

/** SealedNegotiation v1, the first deployment (MONAD_TESTNET_V1). */
export const SEALED_NEGOTIATION_V1_ABI = [
  ...SEALED_COMMON,
  `function getNegotiation(uint256 negotiationId) view returns ((${NEGOTIATION_V1_FIELDS}))`,
  `event NegotiationCreated(${CREATED_V1_FIELDS})`,
] as const;

/** Unchanged between v1 and v2. */
export const REPUTATION_GATE_ABI = [
  "constructor(address identityRegistry, address reputationRegistry)",
  "function identityRegistry() view returns (address)",
  "function reputationRegistry() view returns (address)",
  "function isAgentWallet(uint256 agentId, address wallet) view returns (bool)",
  `function clears(uint256 agentId, ${POLICY_TUPLE} policy) view returns (bool)`,
  `function requireAdmitted(uint256 agentId, address wallet, ${POLICY_TUPLE} policy) view`,
  "error AgentWalletMismatch(uint256 agentId, address expected)",
  "error PolicyDecimalsMismatch(uint8 policyDecimals, uint8 registryDecimals)",
  "error EmptyReviewerSet()",
  "error NotAdmitted(uint256 agentId)",
] as const;

/** The views of the ERC-8004 Identity Registry that Sealed reads. */
export const IDENTITY_REGISTRY_ABI = [
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
] as const;

/** The parts of the ERC-8004 Reputation Registry that Sealed reads or writes. */
export const REPUTATION_REGISTRY_ABI = [
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
] as const;
