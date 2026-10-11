import { AbiCoder, getBytes, keccak256, randomBytes, hexlify, TypedDataEncoder } from "ethers";

/**
 * Off-chain mirror of SealedNegotiation's commitment scheme.
 *
 * An agent never sends its position anywhere until settlement, so it builds the
 * commitment itself rather than asking the contract to build it. This file and
 * `SealedNegotiation.commitmentHash` must agree exactly; `test/commitment.test.ts`
 * checks that they do, against a live deployment, for every case.
 */

export const SEALED_EIP712_DOMAIN_NAME = "Sealed";
export const SEALED_EIP712_DOMAIN_VERSION = "1";

export interface SealedDomain {
  chainId: number | bigint;
  verifyingContract: string;
}

/** A position an agent has decided on but has not disclosed to anyone. */
export interface Position {
  /** Buyer: the most it will pay. Seller: the least it will accept. */
  offer: bigint;
  /** 32 bytes of entropy. Never reused, never logged, never transmitted. */
  salt: string;
}

/**
 * Fresh entropy for a position.
 *
 * Reusing a salt across rounds would let a counterparty compare hashes and learn
 * whether the agent moved, so every position gets its own.
 */
export function newSalt(): string {
  return hexlify(randomBytes(32));
}

export function domainSeparator(domain: SealedDomain): string {
  return TypedDataEncoder.hashDomain({
    name: SEALED_EIP712_DOMAIN_NAME,
    version: SEALED_EIP712_DOMAIN_VERSION,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  });
}

/**
 * keccak256(domainSeparator, negotiationId, party, commitIndex, offer, salt)
 *
 * The domain separator carries chain id and contract address, so a commitment
 * cannot be replayed onto another chain or another deployment. `party` and
 * `commitIndex` mean the same number hashes differently for each side and in
 * every round.
 */
export function commitmentHash(args: {
  domain: SealedDomain;
  negotiationId: bigint;
  party: string;
  commitIndex: number;
  position: Position;
}): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "uint32", "uint256", "bytes32"],
      [
        domainSeparator(args.domain),
        args.negotiationId,
        args.party,
        args.commitIndex,
        args.position.offer,
        args.position.salt,
      ],
    ),
  );
}

/** EIP-712 types for the settlement authorization each agent signs. */
export const SETTLE_AUTHORIZATION_TYPES = {
  SettleAuthorization: [
    { name: "negotiationId", type: "uint256" },
    { name: "buyerCommitment", type: "bytes32" },
    { name: "sellerCommitment", type: "bytes32" },
    { name: "buyerCommitIndex", type: "uint32" },
    { name: "sellerCommitIndex", type: "uint32" },
  ],
} as const;

export interface SettleAuthorizationMessage {
  negotiationId: bigint;
  buyerCommitment: string;
  sellerCommitment: string;
  buyerCommitIndex: number;
  sellerCommitIndex: number;
}

export function settleAuthorizationTypedData(domain: SealedDomain, message: SettleAuthorizationMessage) {
  return {
    domain: {
      name: SEALED_EIP712_DOMAIN_NAME,
      version: SEALED_EIP712_DOMAIN_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: SETTLE_AUTHORIZATION_TYPES,
    primaryType: "SettleAuthorization" as const,
    message,
  };
}

/** Sanity check used before a salt is accepted into a position. */
export function assertSalt(salt: string): void {
  if (getBytes(salt).length !== 32) {
    throw new Error("A commitment salt must be exactly 32 bytes.");
  }
}

/**
 * SealedNegotiationV3: the terms both parties sign before a paid negotiation
 * can open. Mirrors OPEN_NEGOTIATION_TYPEHASH in contracts/SealedNegotiationV3.sol.
 */
export const OPEN_NEGOTIATION_TYPES = {
  OpenNegotiation: [
    { name: "buyerAgentId", type: "uint256" },
    { name: "buyerWallet", type: "address" },
    { name: "sellerAgentId", type: "uint256" },
    { name: "sellerWallet", type: "address" },
    { name: "deadline", type: "uint64" },
    { name: "termsSchema", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "scale", type: "uint256" },
  ],
} as const;

/** How a v3 settlement pays: `price * scale` units of `token`, from the buyer's escrow. */
export interface PaymentTerms {
  token: string;
  scale: bigint;
}

export interface OpenNegotiationMessage {
  buyerAgentId: bigint;
  buyerWallet: string;
  sellerAgentId: bigint;
  sellerWallet: string;
  deadline: bigint;
  termsSchema: string;
  policyHash: string;
  token: string;
  scale: bigint;
}

export function openNegotiationTypedData(domain: SealedDomain, message: OpenNegotiationMessage) {
  return {
    domain: {
      name: SEALED_EIP712_DOMAIN_NAME,
      version: SEALED_EIP712_DOMAIN_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: OPEN_NEGOTIATION_TYPES,
    primaryType: "OpenNegotiation" as const,
    message,
  };
}

/** SealedNegotiationV3: a party's signature that lets anyone submit its commitment for it. */
export const COMMIT_TYPES = {
  Commit: [
    { name: "negotiationId", type: "uint256" },
    { name: "commitment", type: "bytes32" },
    { name: "commitIndex", type: "uint32" },
  ],
} as const;

export interface CommitMessage {
  negotiationId: bigint;
  commitment: string;
  commitIndex: number;
}

export function commitTypedData(domain: SealedDomain, message: CommitMessage) {
  return {
    domain: {
      name: SEALED_EIP712_DOMAIN_NAME,
      version: SEALED_EIP712_DOMAIN_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: COMMIT_TYPES,
    primaryType: "Commit" as const,
    message,
  };
}
