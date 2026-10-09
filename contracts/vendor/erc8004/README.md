# Vendored ERC-8004 registries (test only)

Unmodified copies of the canonical ERC-8004 contracts, MIT licensed, from
[erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) at commit
`b9e466c` (2026-08-15).

They exist so the test suite runs Sealed against the same registry code that is
deployed on Base, behind the same ERC-1967 proxy and UUPS upgrade path, instead of
against hand-written mocks. Sealed never deploys them. In production it reads the
singletons listed in [docs/ADDRESSES.md](../../../docs/ADDRESSES.md).

Why this matters: an earlier version of Sealed was tested against mocks that had
drifted from the real interface. The tests passed and the gate would have reverted
on every call against the live registry. Testing against the real code closes that
gap.
