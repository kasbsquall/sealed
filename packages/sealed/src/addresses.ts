/**
 * Every address the package knows, in one place. When a new SealedNegotiation
 * is deployed, this is the only file to change. `test/sdk.test.mjs` checks it
 * against deployments/monadTestnet.json and scripts/registries.ts.
 */

/** An admission policy as ReputationGate takes it. */
export interface Policy {
  /** Reviewers whose ERC-8004 feedback counts. Must not be empty. */
  reviewers: readonly string[];
  minFeedbackCount: bigint;
  /** In `decimals` fixed point: 400 with decimals 2 is 4.00. */
  minAverageValue: bigint;
  decimals: number;
  /** ERC-8004 tag1 filter, "" for any. */
  tag1: string;
}

export interface SealedDeployment {
  chainId: number;
  name: string;
  /**
   * 2: one commit per side per round, at most one round ahead, settle on the
   * last round both completed, policyHash stored. 1: the first deployment, where
   * any re-commit replaces the pair.
   */
  version: 1 | 2;
  rpcUrl: string;
  explorer: string;
  sealedNegotiation: string;
  reputationGate: string;
  /** Canonical ERC-8004 Identity Registry on this chain. */
  identityRegistry: string;
  /** Canonical ERC-8004 Reputation Registry on this chain. */
  reputationRegistry: string;
  /** The policy the demo negotiations were opened under. */
  demoPolicy: Policy;
}

const MONAD_TESTNET_COMMON = {
  chainId: 10143,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorer: "https://testnet.monadvision.com",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  demoPolicy: {
    reviewers: [
      "0xb5d965E79E52a5b381D3b475987C897B4F1977e5",
      "0x2C345630e11551fd1b9096e09109CF92767dA8aE",
      "0xF567d58C1017342a0021d641f803496AC9c38A8f",
    ],
    minFeedbackCount: 5n,
    minAverageValue: 400n,
    decimals: 2,
    tag1: "",
  },
} as const;

/** v2, the default: commit freeze and stored policy hash. */
export const MONAD_TESTNET_V2: SealedDeployment = {
  ...MONAD_TESTNET_COMMON,
  name: "Monad testnet (Sealed v2)",
  version: 2,
  sealedNegotiation: "0xb9D7c55f77a074f06F449766895eB5b978C273C4",
  reputationGate: "0xF43171CE393a79717B35fF689e814B452583E3Da",
};

/** v1, the first deployment: negotiations #1 to #10 of the published demo runs live here. */
export const MONAD_TESTNET_V1: SealedDeployment = {
  ...MONAD_TESTNET_COMMON,
  name: "Monad testnet (Sealed v1)",
  version: 1,
  sealedNegotiation: "0xAdBd2619c8f51873B6dB131843cce3403E0869dD",
  reputationGate: "0xD7c68cd2197124A7BF3a27467917aBCB982Cc04A",
};

/** The current deployment. */
export const MONAD_TESTNET: SealedDeployment = MONAD_TESTNET_V2;

/** Every deployment, newest first. `verifySettlement` uses it to recognize a settlement's contract. */
export const SEALED_DEPLOYMENTS: readonly SealedDeployment[] = [MONAD_TESTNET_V2, MONAD_TESTNET_V1];
