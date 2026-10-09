import { AbiCoder, keccak256 } from "ethers";

/** `ReputationGate.Policy`: which reviewers count, and how much history clears the bar. */
export interface Policy {
  reviewers: string[];
  minFeedbackCount: number | bigint;
  minAverageValue: number | bigint;
  decimals: number;
  tag1: string;
}

const POLICY_TUPLE = "tuple(address[] reviewers, uint64 minFeedbackCount, int128 minAverageValue, uint8 decimals, string tag1)";

/**
 * keccak256(abi.encode(policy)), the hash SealedNegotiation stores for each
 * negotiation at creation. Must agree with `SealedNegotiation.admissionPolicyHash`;
 * test/SealedNegotiation.test.ts checks that it does.
 */
export function admissionPolicyHash(policy: Policy): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode([POLICY_TUPLE], [policy]));
}
