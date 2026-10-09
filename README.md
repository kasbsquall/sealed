<img src="docs/brand/sealed-mark.svg" width="56" alt="Sealed mark: two crossing lines with an orange square at the crossing point">

# Sealed

**Your AI agent can negotiate a price without showing the other side its budget first.**

Built on Monad testnet · ERC-8004 verified identity and reputation · Privy agent wallets bounded by a contract-scoped mandate · negotiator agents on Qwen.

---

## The problem

You give an AI agent a budget and ask it to buy API access. The seller runs an agent too. If the seller's agent learns your ceiling, it charges your ceiling. On a public chain that leak is the default: every offer an agent submits is readable by anyone, the counterparty included, before the deal closes.

Sealed changes the order in which numbers become visible. Both agents commit sealed offers to Monad. A relay answers one question, whether the offers crossed, and nothing else. When they cross, one transaction settles at the midpoint, which makes the two final offers public. When they never cross, no offer is ever made public.

ERC-8004 already answers whether an agent can be trusted: its Identity and Reputation registries live at the same addresses on Monad and more than twenty other chains. Sealed uses them to decide who may negotiate, and handles the step that comes next, agreeing on a number without exposing it.

## What it does

Two agents, each with an ERC-8004 identity and reputation on Monad, reach an agreement through a contract that never learns either position until both are locked, and never learns either position at all if the deal does not happen.

1. **Admission.** `ReputationGate` checks both agents against an explicit, on-chain policy read from the canonical ERC-8004 Reputation Registry. It answers one bit: does this agent clear the bar. The registry itself is public, so the gate saves the counterparty a lookup rather than hiding anything.
2. **Commitment.** Each agent submits a salted, domain-separated hash of its position. Counter-offers are new commitments, and the same number committed twice produces two unrelated hashes, so an observer watching a sequence of updates cannot tell whether an agent moved or held.
3. **Atomic settlement.** There is no reveal phase. `settle` consumes both offers, both salts and both EIP-712 authorizations in a single transaction. Either both positions land on-chain in the same instant or neither ever does.
4. **Silent failure.** If the positions do not clear, nothing is submitted and the negotiation expires. The chain records that two agents talked and did not trade. It never records what either one asked for.

Between rounds, a **clearing relay** checks each agent's reveal against its on-chain hash and tells both sides one bit: crossed or not. In a round that does not cross, neither agent learns the other's number, so counter-offers stay sealed too.

## Why Monad

A sealed negotiation is a conversation held in transactions: one creation, a commit per agent per round, and one settlement. On a slow or expensive chain that turns a few seconds of agent reasoning into minutes of waiting, and pushes agents toward a single take-it-or-leave-it round. On Monad, scripted negotiation #1 went from creation to settlement in 17 blocks, about 5 seconds by block timestamps, and a commit cost about 0.0056 MON at 102 gwei. That leaves room for several rounds of counter-offers inside the time a person would spend reading one quote.

The ERC-8004 registries are deployed on Monad at their canonical addresses, so the reputation the gate reads is the same registry any other Monad agent writes to.

Two Monad properties changed the code: gas is charged on the limit rather than on gas used, and the public RPC serves logs over at most 100 blocks. Both are handled and documented in [docs/ADDRESSES.md](docs/ADDRESSES.md).

## Why textbook commit-reveal is not enough here

The standard sealed-bid pattern is commit a hash, then reveal. In an auction with many bidders and a deposit at stake, fine. In a two-party negotiation it fails in two specific ways, and both are fixed in [`SealedNegotiation.sol`](contracts/SealedNegotiation.sol).

**Last-revealer advantage.** If A reveals first, B reads A's number and then decides whether revealing still suits it. B walks away having learned everything while exposing nothing. In a bilateral deal that asymmetry is the whole game.

Sealed removes the reveal phase entirely. Settlement is one atomic call carrying both sides, each authorized by an EIP-712 signature bound to the exact pair of commitment hashes and their round indices. Nobody goes first because there is no first. A stale authorization from an earlier round is void the moment either side re-commits.

**A price is not a 256-bit secret.** `keccak256(price)` over a plausible range is brute-forced in milliseconds. Sealed's commitment pre-image binds the EIP-712 domain separator (chain id and contract address), the negotiation id, the committing party, the round index, the offer and a 32-byte salt.

## Agent wallets with a mandate the agent cannot exceed

A negotiator has to sign without a human in the loop, and an agent that can sign anything is a drainable key with a language interface attached. So each negotiator can run on a Privy server wallet whose key stays in Privy's enclave, under a policy that only allows:

- transactions to the deployed `SealedNegotiation`, on Monad testnet, with zero value, plus `register` on the ERC-8004 Identity Registry;
- EIP-712 signatures whose domain is that same Sealed contract on Monad testnet.

Privy denies everything else, including a token transfer, the same transfer signed with `eth_signTransaction` to broadcast elsewhere, and a Permit2 approval presented as typed data. The rules are built as data and covered by 14 tests ([`test/mandate.test.ts`](test/mandate.test.ts)). `npm run demo:privy` runs a negotiation on Privy wallets and then asks Privy to sign those three forbidden things, counting a probe as refused only when Privy answers `policy_violation`. See [docs/PRIVY.md](docs/PRIVY.md).

## What Sealed does not claim

Checking whether two sealed numbers cross needs someone to see both. In Sealed that is the clearing relay ([`agents/relay/clearingRelay.ts`](agents/relay/clearingRelay.ts)), and its power is deliberately narrow:

- it **cannot change or forge a deal**: settlement needs both agents' EIP-712 signatures over the exact committed pair, and the contract re-checks every reveal against its hash;
- it **cannot be lied to**: a reveal that does not hash to the on-chain commitment is rejected;
- it **is trusted with confidentiality**: it sees both numbers of a round that does not cross, and discards them.

So neither the chain nor the counterparty ever learns an agent's position unless the deal settles. The relay does, briefly. The production path is to run it inside an attested TEE, or to replace the comparison with threshold encryption or an FHE coprocessor.

The relay holds no agent key. [`scripts/run-separated.ts`](scripts/run-separated.ts) runs the buyer agent, the seller agent and the relay as three separate processes: each agent loads only its own key and limit and runs its own model client, and the relay reaches them over HTTP ([`agents/relay/party.ts`](agents/relay/party.ts)).

The model provider is a separate question. With a hosted model such as Qwen 3.8 Max, each agent sends its own mandate to the provider on every turn. With a local model through Ollama, the mandate never leaves the operator's machine. Both are a configuration change (`LLM_BASE_URL`, `LLM_MODEL`); an operator who cannot share its limits with a provider should run the agent locally.

Timing metadata is public. The mempool shows that an address committed and when. It never shows what.

Two more limits a reviewer will find in the code. `createNegotiation` is permissionless and takes the admission policy (which reviewers count, and how many reviews) from the caller, so the gate proves the integration with ERC-8004 rather than a policy both sides agreed to; storing the policy hash and having the counterparty co-sign it is the fix. And the NatSpec at the top of `SealedNegotiation.sol` describes agents exchanging reveals with each other, which predates the clearing relay, and the NatSpec of the two registry interfaces mentions Base Sepolia, where they were first checked against the live registries. Both are left unchanged because the contracts are deployed and verified byte for byte, and this README describes the current flow.

## Architecture

```
ERC-8004 canonical registries on Monad testnet   (read only, not deployed by us)
  IdentityRegistry      0x8004A818BFB912233c491871b3d84c89A494BD9e
  ReputationRegistry    0x8004B663056A597Dffe9eCcC1965A193B7388713
        |
        v
  ReputationGate.sol      admission policy over the public registries, one bit out
        |
        v
  SealedNegotiation.sol   commitment, counter-offers, atomic settlement, silent expiry
        |
        v
  NegotiatorAgent         works each round in steps with a model (Qwen 3.8 Max
                          hosted, or a local Qwen through Ollama) and four tools;
                          code checks every number against the mandate
        |
        v
  ClearingRelay           checks reveals against on-chain hashes, answers one bit
                          per round, submits the atomic settlement or the expiry
        |
        v
  Privy agent wallet      optional signer for each agent, limited by policy to
                          Sealed on Monad testnet
```

### The agent works in steps, and code has the last word

Each round, the negotiator's model works through four tools ([`agents/negotiator/tools.ts`](agents/negotiator/tools.ts)):

- `read_negotiation` reads the round, the time left on-chain and the agent's own earlier offers and notes;
- `read_counterparty_reputation` reads the other agent's ERC-8004 reputation on-chain, counting only reviewers the principal trusts;
- `check_offer` says whether a candidate number is allowed and what it means for the principal if it crosses;
- `submit_offer` commits to a number and a note. In round 1 the note is the model's plan for every round; in later rounds the model reads it back and says whether it is following it.

None of the tools can reach the counterparty's number, which is sealed. Every submission goes through the same checks: never past the principal's limit, never back from an earlier concession, never on the wrong scale. A rejected number goes back to the model with the reason, so it can correct itself. After two rejections code takes the model's last number and clamps it, and the transcript records what the model asked for. Every tool call and its result is written to the transcript in `demo-runs/`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ADDRESSES.md](docs/ADDRESSES.md) and [docs/PRIVY.md](docs/PRIVY.md).

## Running it

Requirements: Node.js and npm (tested with Node.js 22).

```bash
npm install
npx hardhat test            # 55 tests, against the real ERC-8004 registry code
npm run check:registries    # calls the live registries on Monad testnet
```

The test suite is where the privacy claims are proved rather than asserted. Among the cases:

- a committed position leaves no trace of the offer or the salt in any log
- the same offer in a later round produces an unrelated commitment
- one party's authorization is never enough to settle, even signed twice
- re-committing voids every authorization signed against the previous round
- a commitment cannot be replayed against another deployment of the same contract
- an expired negotiation puts neither position on-chain
- the agent's own off-chain commitment encoder matches the contract exactly, across the full uint256 range
- an agent never commits past its mandate, whatever the model answers
- the relay refuses a reveal that does not match the on-chain commitment
- an agent fails closed when its model gives no usable answer
- the agent reads the negotiation and the counterparty's on-chain reputation through tools, gets a rejected number back with the reason, and carries its own plan into later rounds
- the Privy mandate allows Sealed calls and refuses transfers, other contracts, other chains and Permit2 signatures

Deploy and run on Monad testnet:

```bash
cp .env.example .env    # fresh deployer key funded at faucet.monad.xyz, plus LLM settings
npm run seed:monad      # deploys, registers three demo agents, seeds reputation, checks the gate
npx hardhat run scripts/smoke-negotiation.ts --network monadTestnet   # scripted negotiation, no model
npm run demo:monad      # two negotiations with model-driven agents, transcripts in demo-runs/
RUN=demo-runs/<file>.json npm run verify:run                          # re-derives every on-chain hash
npm run demo:privy      # needs the Privy settings in .env
```

## Verify it in two minutes

Everything below is on Monad testnet and readable without a wallet.

1. **The contracts are the code in this repo.** [`ReputationGate`](https://testnet.monadvision.com/address/0xD7c68cd2197124A7BF3a27467917aBCB982Cc04A) and [`SealedNegotiation`](https://testnet.monadvision.com/address/0xAdBd2619c8f51873B6dB131843cce3403E0869dD) are verified on Sourcify with an exact match.
2. **They read the real ERC-8004 registries.** `ReputationGate` was deployed pointing at the canonical Identity and Reputation registries (`0x8004A818…`, `0x8004B663…`), and `npm run check:registries` calls them live.
3. **The gate refuses an agent without enough reputation.** Agent 2086 has one seeded review; the policy asks for five. In negotiation #1 the gate refused it with `NotAdmitted` before the buyer and seller were admitted.
4. **A negotiation settled on-chain without either offer appearing before settlement.** Open the two commit transactions of negotiation #1, [`0x74f2a1d8…`](https://testnet.monadvision.com/tx/0x74f2a1d88ddb13fa72c270f1a986c96a414216ac349ee5e49f3c606e46e4d825) and [`0x479cd74d…`](https://testnet.monadvision.com/tx/0x479cd74d2e7bf999cc8ad73ff44d06bb73fc0657474b1f541eb83335ebe33909): each carries a 32-byte hash and nothing else. Both offers become public together, only in the settlement [`0xce6ccd99…`](https://testnet.monadvision.com/tx/0xce6ccd99591b06d46d94fac5bf604b5a7769cb1b58d1312b6b1c395404ac504c), at the midpoint, 4115.
5. **Two Qwen 3.8 Max agents negotiated on Monad, working in steps.** In [negotiation #2](https://testnet.monadvision.com/tx/0xd8f6d83081d4cb79347fe63fbb9101f6a17133627e6a7a596f59ab6cfdd7dac1) each agent read the negotiation and the other agent's ERC-8004 reputation on-chain, checked one to four candidate numbers per round, and wrote a plan in round 1 that it followed or adjusted later, saying why. Rounds 1 and 2 did not cross (3600 against 5200, then 4050 against 4500); in round 3 both committed at their limits and the deal settled at the midpoint, 4200. In [negotiation #3](https://testnet.monadvision.com/tx/0x605ffe8d02cc1d6dfe0ee267d54ed8639c28ee8b72f451b89bee2c741cd8c96a) the limits could not overlap, three rounds did not cross, and the negotiation expired with neither number on-chain. No number had to be corrected by code in either run. Every tool call, its result and each note are in [`demo-runs/`](demo-runs), and `RUN=demo-runs/monadTestnet-deal-2.json npm run verify:run` re-derives every on-chain hash.
6. **The demo reputation is seeded, and labelled that way.** Agents 2084, 2085 and 2086 and their reviewers were created by `scripts/seed-demo.ts`. See [docs/ADDRESSES.md](docs/ADDRESSES.md).

## Business model

This is the plan after the event; the demo charges no fee.

- **Who pays.** The seller, 0.25% of the value of a deal settled through Sealed.
- **First customers.** API and data sellers that sell volume to buying agents. Sealed lets them negotiate a volume price without publishing a price list the other side can game, and a buyer agent that cannot be squeezed is willing to commit to volume.
- **Next, in order.** Move the clearing relay into an attested enclave, code the fee into settlement, deploy on Monad mainnet, and run a pilot with one API seller.
- **Team.** Kevin Soto Burgos, founder.

## Status

| | |
|---|---|
| ERC-8004 registries on Monad testnet checked against Sealed's interfaces | done |
| `SealedNegotiation.sol` with atomic EIP-712 settlement | done, 55 tests in the suite |
| `ReputationGate.sol` with an explicit on-chain admission policy | done |
| Deployment to Monad testnet, source verified on Sourcify | done |
| Scripted negotiation on Monad testnet | done, settled at 4115 |
| Negotiator working in steps with tools (on-chain reads, offer check, plan carried across rounds) | done |
| Negotiations with Qwen 3.8 Max agents on Monad testnet | done, a deal (#2) and a no-deal (#3), both verified |
| Privy wallets under the mandate, with refused probes, on Monad testnet | pending |

## How this was built

This repository was created on 2026-09-17, inside the hackathon window. Its first two commits are the first version of Sealed: the core contracts, the test suite and the Privy wallet policy. Between 2026-09-27 and 2026-10-08 the author kept developing Sealed in a port to Base Sepolia, [kasbsquall/sealed-base](https://github.com/kasbsquall/sealed-base), where that work has its own commit history: the clearing relay, the negotiator agent, the verification scripts and the judge page. That work came back to this repository on 2026-10-08 and was adapted to Monad (fees on the gas limit, log ranges, deployment and seeding), and the Privy mandate was extended with `eth_signTransaction` parity, the ERC-8004 `register` rule and tests. No code predates 2026-09-17.

AI coding tools were used throughout: Claude Code (Anthropic) wrote most of the code and documentation under the author's direction and review.

## License

MIT. See [LICENSE](LICENSE).
