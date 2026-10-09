/**
 * Canonical ERC-8004 singletons on Monad. See docs/ADDRESSES.md.
 *
 * Testnet probed read-only on 2026-10-08: both addresses return ERC-1967 proxy
 * bytecode, name() is "AgentIdentity", getSummary takes four arguments and
 * reverts with "clientAddresses required" on an empty reviewer list.
 */
export const REGISTRIES: Record<number, { identity: string; reputation: string }> = {
  10143: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
  143: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
};
