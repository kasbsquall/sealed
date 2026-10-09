# Architecture

## Design decisions and why

### 1. We read the canonical ERC-8004 registries, we do not redeploy them

The registries already exist on Monad testnet and mainnet at deterministic CREATE2
addresses, audited.
Deploying our own copies would produce a demo that integrates with nothing. Sealed
reads the real singletons through two minimal interfaces
([`IIdentityRegistry`](../contracts/interfaces/IIdentityRegistry.sol),
[`IReputationRegistry`](../contracts/interfaces/IReputationRegistry.sol)) that expose
only the views it needs.

### 2. The admission policy is ours, is explicit, and lives on-chain

ERC-8004 deliberately has no `getScore()`. The Reputation Registry stores individual
feedback entries and exposes `getSummary()`; any aggregate judgement is a consumer
decision. That is the right call by the standard, and it means the interesting part
is ours to define and to defend.

[`ReputationGate`](../contracts/ReputationGate.sol) takes a `Policy` struct:

- `reviewers`: the addresses whose feedback counts. ERC-8004 refuses a summary over
  "everyone" (`getSummary` reverts with `clientAddresses required`), and the gate
  agrees with that: reputation from any address at all is Sybil-farmable, so a
  policy has to name whose judgement it trusts. Fifty perfect scores from an
  address outside the set change nothing, and there is a test proving it.
- `minFeedbackCount`: how much history is enough. Guards against a fresh address with
  one flattering review.
- `minAverageValue` and `decimals`: the bar, in the registry's own fixed point.
- `tag1`: optional ERC-8004 tag, so a policy can demand a track record in the
  relevant domain rather than generic goodwill.

Revoked feedback never counts. The policy is attached to a negotiation at creation
and is readable by anyone, including the counterparty. Hiding this logic in an
off-chain service would defeat the purpose of an on-chain trust layer.

The gate also checks `getAgentWallet(agentId)` on the Identity Registry, so the
signing address has to be the agent's registered wallet and nobody can borrow
another agent's reputation by quoting its id.

The test suite runs against the real ERC-8004 registry code, vendored unmodified in
[`contracts/vendor/erc8004`](../contracts/vendor/erc8004), deployed behind the same
proxy pattern as on Monad. `npm run check:registries` calls the live Monad testnet
registries through Sealed's own interfaces and fails if they ever drift.

**Known limitation, stated openly:** a policy with a high `minFeedbackCount`
reinforces the reputation-concentration risk already identified in the ERC-8004
ecosystem, where established agents crowd out new ones. Sealed does not solve that.
It makes the bar visible and per-negotiation, so at least it is a choice rather than
a platform default.

### 3. Atomic settlement instead of a reveal phase

Covered at length in the contract's own header comment and in the README. Short
version: in a bilateral deal, whoever reveals second holds all the cards, so Sealed
removes the concept of revealing second. `settle` takes both offers, both salts and
both EIP-712 authorizations in one call.

The authorization binds `(negotiationId, buyerCommitment, sellerCommitment,
buyerCommitIndex, sellerCommitIndex)`. Because it includes the commitment hashes and
the round indices, in the deployed contract a new commitment by either side silently
voids both signatures. From v2 on, the signatures cover the last round both sides have
committed. One side committing again leaves that pair as it was, so a party cannot void a
pair it signed by racing a commitment ahead of a broadcast settlement; the pair, and with
it the old signatures, moves on only when both sides commit a new round. Either way, once
both sides have moved on, an old position cannot be forced through.

### 4. Commitments are domain-separated

`commitmentHash = keccak256(domainSeparator, negotiationId, party, commitIndex,
offer, salt)`.

The domain separator carries chain id and contract address, so a commitment cannot
be replayed onto another chain or another deployment. `party` and `commitIndex` mean
the same number produces a different hash in every round and for each side, so an
observer watching a sequence of updates learns nothing about movement. The 32-byte
salt is what makes brute force over a small price range infeasible.

### 5. Price discovery: midpoint split

A deal clears when the buyer's ceiling reaches the seller's floor, and settles at the
midpoint of the two. The surplus is split rather than captured by whoever happened to
submit the transaction. This keeps the incentive to state a true position instead of
gaming submission order.

### 6. Failure is an expiry, not a reverted settlement

If the positions do not clear, the agents simply never submit a settlement and the
negotiation expires at its deadline. Nothing either side wanted ever reaches the
chain. A reverted `settle` would still publish both numbers in calldata, so the
protocol treats expiry as the normal failure path and `IncompatibleOffers` as a
safety net.

## Contract surface

### `SealedNegotiation`

| Function | Who | What it does |
|---|---|---|
| `createNegotiation` | anyone | Opens a negotiation between two agents that both clear the policy. Reputation is read here and only here. |
| `commitOffer` | either party | Locks or replaces a position. Bumps that party's commit index. |
| `settle` | anyone holding both payloads | Verifies both commitments, both authorizations, and compatibility. Settles at the midpoint. |
| `expire` | anyone, after the deadline | Closes a negotiation with nothing disclosed. |
| `commitmentHash` | view | Helper agents use off-chain to build their commitment. |
| `settleAuthorizationDigest` | view | The EIP-712 digest to sign for the current state. |

### Events and what they withhold

`NegotiationCreated`, `OfferCommitted`, `NegotiationLocked`, `NegotiationExpired`
carry no offer value at all. `NegotiationSettled` carries the agreed price only,
never the two positions that produced it. An observer learns the clearing price of a
completed deal, which is the point of a public ledger, and never learns either
party's true limit.

## Layers above the contracts

**Negotiator agent.** Receives a mandate from its principal (a reservation price, a
walk-away point, a concession budget), decides what to commit each round, and decides
when to authorize settlement. The mandate is never disclosed, to the counterparty or
to the chain. Only the resulting commitment hash goes out.
