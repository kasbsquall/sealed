# Integrating Sealed

This page is for a developer who already has an ERC-8004 agent and wants it to agree a
price with another agent without either side seeing the other's limit. It covers the
contract calls, the commitment encoding, the authorization each agent signs, and the two
ways to plug your own agent in.

Prices are integers in whatever unit the two sides agree on. The demo uses US cents per
1,000 API calls, so `4200` means $42.00. The unit is part of the terms; the contract only
stores `keccak256` of the terms text as `termsSchema`.

## Start from the package

Everything below is also in the npm package [`sealed-monad`](https://www.npmjs.com/package/sealed-monad):
the encoders, the ABIs and both deployments' addresses, a read-only client, and the HTTP
party server for Option A. It defaults to v2, the current contract.

```bash
npm install sealed-monad
```

```ts
import { createReadClient, commitmentHash, newSalt, sealedDomain } from "sealed-monad";

const sealed = createReadClient(); // v2 on Monad testnet, public RPC, no keys
const salt = newSalt(); // fresh every round; never log it, never reuse it
const commitment = commitmentHash({ domain: sealedDomain(), negotiationId, party: myWallet,
  commitIndex: 1, position: { offer: 4200n, salt } });
// send it with commitOffer(negotiationId, commitment) from your agent's own wallet
```

`createReadClient()` also checks admission (`checkAdmission`), reads reputation and
verifies a settlement (`verifySettlement`); the package README lists every export. The
read-only MCP server ships in the same package: for Claude Code,
`claude mcp add sealed -- npx -y -p sealed-monad sealed-mcp`.

## Deployed contracts (Monad testnet, chain 10143)

| Contract | Address |
|---|---|
| SealedNegotiation (v2, current) | `0xb9D7c55f77a074f06F449766895eB5b978C273C4` |
| ReputationGate (v2, current) | `0xF43171CE393a79717B35fF689e814B452583E3Da` |
| SealedNegotiation (first deployment; runs #2-#10 and Privy run #8) | `0xAdBd2619c8f51873B6dB131843cce3403E0869dD` |
| ReputationGate (first deployment) | `0xD7c68cd2197124A7BF3a27467917aBCB982Cc04A` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Both Sealed contracts are verified on Sourcify (exact match). Transactions and the demo
agents are listed in [ADDRESSES.md](ADDRESSES.md).

## The flow in five calls

```solidity
// 1. Anyone opens it. Both agents must clear `policy` in the ERC-8004 Reputation
//    Registry, and each wallet must be its agent's registered wallet.
function createNegotiation(
    uint256 buyerAgentId, address buyerWallet,
    uint256 sellerAgentId, address sellerWallet,
    uint64 deadline,            // more than 60 s from now
    bytes32 termsSchema,        // keccak256 of the terms text
    ReputationGate.Policy calldata policy
) returns (uint256 negotiationId);

struct Policy {
    address[] reviewers;        // only these reviewers count; must not be empty
    uint64 minFeedbackCount;
    int128 minAverageValue;     // in `decimals`, e.g. 400 with decimals 2 = 4.00
    uint8 decimals;
    string tag1;                // "" for any
}

// 2. Each round, each side commits a hash. Never the number.
function commitOffer(uint256 negotiationId, bytes32 commitment);

// 3. Each side signs an EIP-712 authorization over the current pair of commitments.
//    Off-chain; see below.

// 4. If the numbers cross, one call settles at the midpoint and is the only moment
//    either number touches the chain.
function settle(
    uint256 negotiationId,
    Reveal calldata buyerReveal,    // (uint256 offer, bytes32 salt)
    Reveal calldata sellerReveal,
    bytes calldata buyerAuthorization,
    bytes calldata sellerAuthorization
) returns (uint256 price);          // seller + (buyer - seller) / 2

// 5. If they never cross, anyone closes it after the deadline. Nothing is revealed.
function expire(uint256 negotiationId);
```

Read state with `getNegotiation(id)`. Events: `NegotiationCreated`, `OfferCommitted`
(party and index, never the offer), `NegotiationLocked`, `NegotiationSettled(id, price)`,
`NegotiationExpired`. Errors: `NotAParty`, `DeadlinePassed`, `DeadlineNotPassed`,
`DeadlineTooSoon`, `CommitmentMismatch`, `BadAuthorization`, `IncompatibleOffers`,
`WrongStatus`, `AlreadyCommitted(index)` on v2 (a second commit before the other side catches up),
plus the gate's `NotAdmitted`, `AgentWalletMismatch` and `EmptyReviewerSet` on creation.

A new agent clears the gate once it has the reviews the creator's policy asks for. The demo
policy wants five reviews from its listed reviewers ([ADDRESSES.md](ADDRESSES.md)). To test
with your own agents, open the negotiation with a policy whose reviewers you control and have
them rate both agents with `giveFeedback` first. The policy is the creator's choice, which is
why v2 stores its hash; see "What you are trusting" below.

In the first deployment (`contractsV1` in `deployments/monadTestnet.json`), re-committing
is allowed until the deadline, and each re-commit bumps that party's index, which voids
every authorization signed over the previous pair.

In v2, the current deployment, each side commits once per round and can be at most one round ahead of the
other. A second commit before the other side catches up reverts with
`AlreadyCommitted(index)`, so a commitment can no longer be replaced within a round. The
pair `settle` accepts is the last round both sides have committed; it moves on, voiding
the old authorizations, only when both sides commit a new round. One side committing
again, for example ahead of a broadcast settlement, leaves it where it was. v2 also stores
`keccak256(abi.encode(policy))` in the negotiation as `policyHash` and emits it in
`NegotiationCreated`.

## The commitment

```ts
import { AbiCoder, keccak256, TypedDataEncoder, hexlify, randomBytes } from "ethers";

const domainSeparator = TypedDataEncoder.hashDomain({
  name: "Sealed", version: "1", chainId: 10143, verifyingContract: SEALED_ADDRESS,
});

const salt = hexlify(randomBytes(32));      // fresh every round, never reused or logged
const commitment = keccak256(AbiCoder.defaultAbiCoder().encode(
  ["bytes32", "uint256", "address", "uint32", "uint256", "bytes32"],
  [domainSeparator, negotiationId, myWallet, nextCommitIndex, offer, salt],
));
```

`nextCommitIndex` is your current index plus one (the first commit is 1). The contract
exposes the same function as `commitmentHash(negotiationId, party, commitIndex, offer,
salt)`, so you can check your encoder against it with an `eth_call`.
[`agents/sealed/commitment.ts`](../agents/sealed/commitment.ts) is the reference
implementation, exported by `sealed-monad` as `commitmentHash`, and `test/commitment.test.ts` checks it against a live deployment.

## The authorization

```ts
const types = {
  SettleAuthorization: [
    { name: "negotiationId", type: "uint256" },
    { name: "buyerCommitment", type: "bytes32" },
    { name: "sellerCommitment", type: "bytes32" },
    { name: "buyerCommitIndex", type: "uint32" },
    { name: "sellerCommitIndex", type: "uint32" },
  ],
};
const domain = { name: "Sealed", version: "1", chainId: 10143, verifyingContract: SEALED_ADDRESS };
const signature = await wallet.signTypedData(domain, types, {
  negotiationId, buyerCommitment, sellerCommitment, buyerCommitIndex, sellerCommitIndex,
});
```

Signing is safe without knowing the other number. `settle` pays the midpoint of two
numbers that cross, so a buyer never pays above its own number and a seller never
receives below its own. Only sign a message whose commitment and index on your side are
your own latest.

Sign in every round, before anyone compares. If an agent were asked to sign only when the
numbers crossed, the request itself would tell it they crossed, and it could refuse and
lower its number. The reference relay asks for both signatures every round, right after
both commitments are on-chain and before it compares. Before comparing it requires both
on-chain indices to equal the round and each signature to recover to that party's wallet;
anything else ends the negotiation as a refusal, without comparing. It keeps 30 seconds
of chain time clear of the deadline before asking, comparing or sending, because a
settlement mined after the deadline reverts with both offers in its calldata, and it
simulates `settle` before sending it. A relay of your own should do the same. Against the
first deployment that narrows the mempool window without closing it: a party watching the
mempool can still re-commit ahead of a broadcast settlement. From v2 on, the contract
closes it: the re-commit only opens that party's next round and the settlement lands.

## Plugging in your own agent

**Option A: your agent, our relay.** Run your agent as a small HTTP service that answers
five POST routes, plus an optional sixth, and point the relay at it. The agent keeps its key; the relay never holds
one. Every request carries `Authorization: Bearer <token>`, a random secret of at least 32
characters that the agent is started with and only the relay knows; anything else gets
`401`. `/reveal` answers once per commitment. The reference server listens on `127.0.0.1`,
so the relay and the agent share a machine; across machines, put it behind TLS.

| Route | Body | Returns |
|---|---|---|
| `/identity` | `{}` | `{ address }` |
| `/decide` | `{ round, negotiationId }` | the round's decision (offer, stance, explanation) |
| `/commit` | `{ negotiationId, commitIndex }` | `{ txHash, commitment }` after committing on-chain |
| `/reveal` | `{}` | `{ party, commitIndex, position: { offer, salt } }` |
| `/authorize` | the SettleAuthorization message | `{ signature }` |
| `/rate` (optional) | `{ settleTx }` | `{ txHash }` of the agent's ERC-8004 review of the other party, after checking the settlement on-chain (see `agents/sealed/dealFeedback.ts`) |

Bigints travel as decimal strings. [`agents/relay/party.ts`](../agents/relay/party.ts)
has both sides of this wire (in the package: `serveParty`, `partyHandler` and `HttpParty`). A complete
agent built this way, outside this repository and on the package only, is
[kasbsquall/sealed-seller-agent](https://github.com/kasbsquall/sealed-seller-agent): a rule-based API
seller that settled v2 negotiation #7 against the Qwen buyer through `scripts/run-external.ts`. In this repository, `scripts/run-separated.ts` runs buyer, seller and relay
as three processes.

**Option B: our agent, your model.** The negotiator speaks to any OpenAI-compatible
endpoint with tool calling. Set `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`; the
defaults point at Qwen 3.8 Max on Alibaba Model Studio, and Ollama works with
`http://localhost:11434/v1`.

## Environment

| Variable | Used by | Notes |
|---|---|---|
| `MONAD_RPC_URL` | everything | defaults to `https://testnet-rpc.monad.xyz` |
| `DEPLOYER_PRIVATE_KEY` | deploy, seed, relay | pays gas for create, settle and expire |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | negotiator | any OpenAI-compatible endpoint with tools |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | `demo:privy` | Privy app credentials |
| `PRIVY_KEY_QUORUM_ID`, `PRIVY_AUTHORIZATION_KEY` | `demo:privy` | the agent's key quorum: signs under the mandate and owns nothing (a 2-of-2 admin quorum owns the policy and the wallets) |
| `PRIVY_BROADCAST` | `demo:privy` | `privy` (default) or `self` |

`.env.example` has the full list with comments.

## What you are trusting

The relay sees both numbers of every round and is trusted to discard them, and to report
the crossed-or-not bit honestly. It cannot forge or change a deal: settlement needs both
signatures over the exact committed pair, and the contract checks both reveals against
their hashes. The README's "What Sealed does not claim" section covers the rest.
