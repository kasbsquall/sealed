# sealed-monad

SDK and read-only MCP server for [Sealed](https://github.com/kasbsquall/sealed): two AI agents agree a price on Monad without either one seeing the other's limit first. Offers go on-chain as salted, domain-separated hashes; a clearing relay tells both sides only whether their numbers crossed; one atomic EIP-712 settlement discloses both offers and settles at the midpoint. Admission is decided by ERC-8004 reputation through `ReputationGate`.

The package is built from the reference code in the Sealed repository (`agents/sealed`, `agents/relay`), bundled so it stands alone. Its encoders are tested against the contracts: they reproduce every commitment of negotiation #4 on Monad testnet and the contract's own settlement digest and policy hash.

## Install

```bash
npm install sealed-monad
```

Node 20 or later. Runtime dependencies: `ethers` 6, `express` 5 (party server), `@modelcontextprotocol/sdk` and `zod` (MCP server).

## v1 and v2

Two SealedNegotiation contracts live on Monad testnet (chain 10143). The package defaults to v2 and still reads v1.

| | v2 (default, `MONAD_TESTNET_V2`) | v1 (`MONAD_TESTNET_V1`) |
|---|---|---|
| SealedNegotiation | `0xb9D7c55f77a074f06F449766895eB5b978C273C4` | `0xAdBd2619c8f51873B6dB131843cce3403E0869dD` |
| ReputationGate | `0xF43171CE393a79717B35fF689e814B452583E3Da` | `0xD7c68cd2197124A7BF3a27467917aBCB982Cc04A` |
| Commits | One per side per round, at most one round ahead; a second commit before the other side catches up reverts with `AlreadyCommitted(index)` | Any re-commit replaces that side's commitment and bumps its index |
| Settled pair | The last round both sides committed, signed with that round as both indices. One side committing ahead cannot void it | Both sides' latest commitments and indices |
| Admission policy | `policyHash = keccak256(abi.encode(policy))` stored in `getNegotiation` and emitted in `NegotiationCreated`; `admissionPolicyHash(policy)` view | Not stored |
| Published demo runs | New runs | Negotiations #1 to #10, the gate refusal, the Privy mandate |

The ERC-8004 registries are the same for both. The EIP-712 domain name and version are the same too; only `verifyingContract` differs, so a commitment for one contract never matches the other.

## SDK in ten lines

```ts
import { MONAD_TESTNET_V1, createReadClient, commitmentHash, newSalt, sealedDomain } from "sealed-monad";

const sealed = createReadClient(); // v2 on Monad testnet over its public RPC; pass { rpcUrl } to change it
const v1 = createReadClient({ deployment: MONAD_TESTNET_V1 });
const n = await v1.getNegotiation(4n); // "Settled", settledPrice 4190n, policyHash null on v1

const salt = newSalt(); // fresh every round; never log it, never reuse it
const commitment = commitmentHash({ domain: sealedDomain(), negotiationId: 1n, party: myWallet,
  commitIndex: 1, position: { offer: 4200n, salt } }); // sealedDomain() is v2

const report = await sealed.verifySettlement("0xb4f7adf14c5253ce89e16dd33f7d81365819262e6510148b4dbeb70fd88ce498");
console.log(report.ok, report.contractVersion); // true 1: recognized as a v1 settlement by its contract
```

`commitmentHash` makes no network call. You send `commitment` with `commitOffer(negotiationId, commitment)` from your agent's own wallet; the offer and the salt stay with your agent until settlement.

## Public API

**Commitments and authorizations**

| Export | What it does |
|---|---|
| `commitmentHash({ domain, negotiationId, party, commitIndex, position })` | `keccak256(domainSeparator, negotiationId, party, commitIndex, offer, salt)`, equal to the contract's `commitmentHash` |
| `newSalt()`, `assertSalt(salt)` | 32 bytes of fresh entropy; the check that a salt is 32 bytes |
| `domainSeparator(domain)`, `sealedDomain(deployment?)` | EIP-712 domain separator; the `{ chainId, verifyingContract }` of a deployment (v2 by default) |
| `settleAuthorizationTypedData(domain, message)` | Typed data for `signTypedData`, for the `SettleAuthorization` each agent signs every round. On v2 both indices are the round |
| `settleAuthorizationDigest(domain, message)` | The digest, equal to the contract's `settleAuthorizationDigest(id)` for the settleable pair |
| `admissionPolicyHash(policy)` | `keccak256(abi.encode(policy))`, equal to v2's `admissionPolicyHash` and to the `policyHash` it stores |
| `SETTLE_AUTHORIZATION_TYPES`, `SEALED_EIP712_DOMAIN_NAME`, `SEALED_EIP712_DOMAIN_VERSION` | The EIP-712 types and domain name ("Sealed") and version ("1") |

**Addresses and ABIs**

| Export | What it does |
|---|---|
| `MONAD_TESTNET` | The current deployment, v2: chain id 10143, public RPC, `SealedNegotiation`, `ReputationGate`, the ERC-8004 registries, the demo admission policy |
| `MONAD_TESTNET_V2`, `MONAD_TESTNET_V1`, `SEALED_DEPLOYMENTS` | Each deployment, with its `version`; the list, newest first |
| `SEALED_NEGOTIATION_ABI`, `REPUTATION_GATE_ABI` | Full human-readable v2 ABIs, checked against the compiled contracts. ethers: `new Interface(abi)`; viem: `parseAbi(abi)` |
| `SEALED_NEGOTIATION_V1_ABI` | The v1 ABI (twelve-field `getNegotiation`, no `policyHash`, no `AlreadyCommitted`). The gate ABI did not change |
| `IDENTITY_REGISTRY_ABI`, `REPUTATION_REGISTRY_ABI` | The ERC-8004 functions and event Sealed reads or writes |

**Read client** (`createReadClient(options?)` returns a `SealedReader` for v2, or for `options.deployment`; no keys)

| Method | What it returns |
|---|---|
| `getNegotiation(id, contract?)` | Status (`None`, `Open`, `Locked`, `Settled`, `Expired`), wallets, agent ids, latest commitments and commit indices, deadline, settled price, terms hash, and `layout` (1 or 2). On v2 also `policyHash` and `settleableRound`, the round `settle` takes; both are null on v1. Words a later version appends come back raw in `extra` |
| `getCommitIndices(id)` | `{ buyer, seller }`; a side's next commit is its index plus one |
| `checkAdmission(agentId, { wallet?, policy? })` | Whether the wallet is the agent's ERC-8004 wallet, whether the agent clears the policy in `ReputationGate`, both together (`admitted`), and the policy's `policyHash` |
| `readReputation(agentId, { reviewers?, tag1?, tag2? })` | ERC-8004 `getSummary` over the trusted reviewers: count, average, decimals |
| `verifySettlement(txHash, { lookbackBlocks? })` | Every check below, each with pass or fail, on a v1 or a v2 settlement |
| `negotiationCount()` | Number of negotiations opened on this deployment |

`verifySettlement` needs only the settlement hash. It recognizes the contract from the transaction's target among the known deployments, and the version from the shape `getNegotiation` returns. It decodes the settle calldata, works out the settled pair (both latest commitments on v1; on v2 the last round both committed, reading a side that committed ahead from its commit transaction for that round), recomputes both commitments from the disclosed offers and salts and compares them with that pair and with the contract's own `commitmentHash`, checks the EIP-712 domain and that the digest over the pair equals the contract's, recovers both signers, checks that the offers cross, that `NegotiationSettled` carries the midpoint and that the contract recorded it, and checks that each settled commitment came from a `commitOffer` sent by its party carrying only the negotiation id and the hash. It walks back from the settlement in 100-block `eth_getLogs` windows, the most Monad's public RPC serves, 3,000 blocks by default.

**Party server** (option A in [INTEGRATING.md](https://github.com/kasbsquall/sealed/blob/main/docs/INTEGRATING.md): your agent, the Sealed relay)

| Export | What it does |
|---|---|
| `serveParty(agent, token, port?)` | Serves your agent on `127.0.0.1` with the relay's routes: `/identity`, `/decide`, `/commit`, `/reveal`, `/authorize`, and `/rate` if your agent rates counterparties. Every request needs `Authorization: Bearer <token>`; `/reveal` answers once per commitment |
| `partyHandler(agent, token)` | The same routes as a Node request listener, to mount yourself behind TLS |
| `HttpParty.connect(url, token)`, `serverUrl(server)` | The relay's side of the wire, useful to test your agent |
| `Party`, `Decision`, `Reveal`, `AgentStep`, `Stance`, `STANCES` | What your agent implements and returns |

```ts
import { serveParty, type Party } from "sealed-monad";

const agent: Party = { wallet, decide, commit, reveal, authorize }; // your model, your key
const server = await serveParty(agent, process.env.PARTY_TOKEN!); // a random secret, 32+ characters
```

Your agent commits on-chain with its own key in `commit`, signs in `authorize`, and decides when to stop. The relay never holds a key that can sign for it. On v2, commit once per round: a second commit in the same round reverts. `scripts/agent-process.ts` in the repository is a complete agent process built this way.

## MCP server

`sealed-mcp` speaks MCP over stdio. It is read-only and holds no keys.

Claude Code:

```bash
claude mcp add sealed -- npx -y -p sealed-monad sealed-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sealed": { "command": "npx", "args": ["-y", "-p", "sealed-monad", "sealed-mcp"] }
  }
}
```

To use another RPC endpoint, set `SEALED_RPC_URL` (or `MONAD_RPC_URL`), for example `claude mcp add sealed -e SEALED_RPC_URL=https://... -- npx -y -p sealed-monad sealed-mcp`. The server only ever shows the endpoint's origin, never its path or query, where providers put API keys.

| Tool | Input | Output |
|---|---|---|
| `get_negotiation` | `negotiationId`, optional `deployment` (`v2` default, `v1`) | Status, parties, agent ids, commitments, commit indices and next indices, deadline, settled price; on v2 `policyHash` and `settleableRound` |
| `check_admission` | `agentId`, optional `wallet`, `policy`, `deployment` | Wallet check, policy check, `admitted`, the policy's hash |
| `read_reputation` | `agentId`, optional `reviewers`, `tag1`, `tag2` | Count and average of ERC-8004 reviews from those reviewers |
| `compute_commitment` | `negotiationId`, `party`, `commitIndex`, `offer`, `salt`, optional `deployment`, `chainId`, `verifyingContract` | The commitment and domain separator, computed locally |
| `verify_settlement` | `txHash`, optional `lookbackBlocks` | Every check of `verifySettlement`, with pass or fail; v1 or v2 is picked from the transaction |
| `describe_protocol` | none | How Sealed works, both versions and their addresses, the demo policy |

The same protocol text is also a resource, `sealed://protocol`.

## What it does not do

- The MCP server cannot commit, sign, settle, expire or rate. It has no key and asks for none. It reads the chain and computes hashes.
- The SDK does not run a negotiation for you. The party server needs your own agent and your own key; the clearing relay itself, which pays gas for create, settle and expire, lives in the repository (`agents/relay/clearingRelay.ts`), not in this package.
- `compute_commitment` is for checking published reveals. A live salt is a secret that belongs to its agent; do not paste one into a tool whose transcript others can read.
- The relay is trusted with confidentiality: it sees both numbers of every round. It cannot forge or change a deal. The repository README explains the trust model in full.
- Monad testnet only for now. A deployment is one object (`SealedDeployment`); pass your own to `createReadClient({ deployment })`.

## Development

```bash
npm install
npm test                        # builds, then unit tests, the party server, and an MCP stdio smoke test, offline
npm run live                    # through the MCP server on Monad testnet: the v1 settlement of #4, reads on v1 and v2
npm run live -- <v2 settle tx>  # the same, plus a v2 settlement
```

At the repository root, `npx hardhat test test/sdk.test.ts` deploys v2 locally and checks the encoders, the ABIs and the read client against it, including a settlement where one side committed a round ahead.

## Changelog

- 0.2.0: v2 is the default (`MONAD_TESTNET`); v1 stays available as `MONAD_TESTNET_V1` with `SEALED_NEGOTIATION_V1_ABI`. `getNegotiation` reads both layouts and returns `policyHash`, `settleableRound` and `layout`; `admissionPolicyHash`; `verifySettlement` handles v1 and v2 settlements; the MCP read tools take `deployment`.
- 0.1.0: first release, v1.

## License

MIT
