# Sealed

**Two AI agents negotiate a deal without either one seeing the other's position first.**

Built on Monad · ERC-8004 verified identity and reputation · Monad Metropolis, Trust, Identity & AI Infrastructure track.

---

## The gap

ERC-8004 shipped to Ethereum mainnet in January 2026. In three months of testnet it collected more than 10,000 registered agents and 20,000 feedback entries, and a whole ecosystem grew on top of it: AgentPass, Helixa, Chitin, a full TRON port. Every one of them answers the same question.

> How much can I trust this agent before I deal with it?

That question is now well solved. The one nobody solved is what happens immediately after the answer is yes.

> Two agents that both trust each other now have to agree on a number. How does either one make an offer without handing the other the information needed to exploit it?

Verified reputation tells you an agent exists and has a track record. It tells you nothing about what happens when that agent sits down to negotiate a price, a rate, or a term, and its counterparty can read its position off the mempool.

Sealed is that missing layer.

## What it does

Two agents, each with an ERC-8004 identity and reputation on Monad, reach an agreement through a contract that never learns either position until both are locked, and never learns either position at all if the deal does not happen.

1. **Admission.** `ReputationGate` checks both agents against an explicit, on-chain policy read from the canonical ERC-8004 Reputation Registry. It answers one bit: does this agent clear the bar. It never exposes the agent's history to its counterparty.
2. **Commitment.** Each agent submits a salted, domain-separated hash of its position. Counter-offers are new commitments, and the same number committed twice produces two unrelated hashes, so an observer watching a sequence of updates cannot tell whether an agent moved or held.
3. **Atomic settlement.** There is no reveal phase. `settle` consumes both offers, both salts and both EIP-712 authorizations in a single transaction. Either both positions land on-chain in the same instant or neither ever does.
4. **Silent failure.** If the positions do not clear, nothing is submitted and the negotiation expires. The chain records that two agents talked and did not trade. It never records what either one asked for.

## Why textbook commit-reveal is not enough here

The standard sealed-bid pattern is commit a hash, then reveal. In an auction with many bidders and a deposit at stake, fine. In a two-party negotiation it fails in two specific ways, and both are fixed in [`SealedNegotiation.sol`](contracts/SealedNegotiation.sol).

**Last-revealer advantage.** If A reveals first, B reads A's number and then decides whether revealing still suits it. B walks away having learned everything while exposing nothing. In a bilateral deal that asymmetry is the whole game.

Sealed removes the reveal phase entirely. Settlement is one atomic call carrying both sides, each authorized by an EIP-712 signature bound to the exact pair of commitment hashes and their round indices. Nobody goes first because there is no first. A stale authorization from an earlier round is void the moment either side re-commits.

**A price is not a 256-bit secret.** `keccak256(price)` over a plausible range is brute-forced in milliseconds. Sealed's commitment pre-image binds the EIP-712 domain separator (chain id and contract address), the negotiation id, the committing party, the round index, the offer and a 32-byte salt.

## What Sealed does not claim

Once both commitments are locked, the two agents exchange reveal payloads with each other off-chain to check compatibility. At that moment each learns the other's final number. That disclosure is simultaneous and post-commitment: neither agent can still change its own position, because its own position is already hashed on-chain. That is exactly the sealed-bid guarantee, and it is the honest limit of what is reachable without threshold encryption or an FHE coprocessor.

Sealed guarantees that nothing leaks **before** commitment, and that nothing leaks **unilaterally**, ever.

Timing metadata is public. The mempool shows that an address committed and when. It never shows what.

## Architecture

```
ERC-8004 canonical registries on Monad        (read only, not deployed by us)
  IdentityRegistry      0x8004A818BFB912233c491871b3d84c89A494BD9e  (testnet)
  ReputationRegistry    0x8004B663056A597Dffe9eCcC1965A193B7388713  (testnet)
        |
        v
  ReputationGate.sol      admission policy, one bit out, history stays private
        |
        v
  SealedNegotiation.sol   commitment, counter-offers, atomic settlement, silent expiry
        |
        v
  Privy agent wallets     each agent signs autonomously, under a policy whose
                          contract allowlist is Sealed and nothing else
        |
        v
  NegotiatorAgent         decides the position within its principal's mandate,
                          and never discloses that mandate to anyone
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ADDRESSES.md](docs/ADDRESSES.md).

## Running it

```bash
npm install
npx hardhat test
```

The test suite is where the privacy claims are proved rather than asserted. Among the cases:

- a committed position leaves no trace of the offer or the salt in any log
- the same offer in a later round produces an unrelated commitment
- one party's authorization is never enough to settle, even signed twice
- re-committing voids every authorization signed against the previous round
- a commitment cannot be replayed against another deployment of the same contract
- an expired negotiation puts neither position on-chain

Deploy to Monad testnet (chain id 10143):

```bash
cp .env.example .env   # fill in DEPLOYER_PRIVATE_KEY
npm run deploy:monad
```

## Status

| | |
|---|---|
| ERC-8004 integration researched and addresses confirmed | done |
| `SealedNegotiation.sol` with atomic EIP-712 settlement | done, 19 tests passing |
| `ReputationGate.sol` with explicit on-chain admission policy | done |
| Deployment to Monad testnet | in progress |
| Privy agent wallets | in progress |
| Negotiator agent (Qwen 3 Max) | in progress |
| Dual-scenario frontend demo | in progress |

## License

MIT. See [LICENSE](LICENSE).
