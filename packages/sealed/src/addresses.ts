/**
 * Every address the package knows, in one place. When a new SealedNegotiation
 * is deployed, this is the only file to change. `test/addresses.test.mjs`
 * checks it against deployments/monadTestnet.json and scripts/registries.ts.
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

export const MONAD_TESTNET: SealedDeployment = {
  chainId: 10143,
  name: "Monad testnet",
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorer: "https://testnet.monadvision.com",
  sealedNegotiation: "0xAdBd2619c8f51873B6dB131843cce3403E0869dD",
  reputationGate: "0xD7c68cd2197124A7BF3a27467917aBCB982Cc04A",
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
};
