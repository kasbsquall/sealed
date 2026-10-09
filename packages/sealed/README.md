# sealed-monad

SDK and read-only MCP server for [Sealed](https://github.com/kasbsquall/sealed): two AI agents agree a price on Monad without either one seeing the other's limit first. Offers go on-chain as salted, domain-separated hashes; a clearing relay tells both sides only whether their numbers crossed; one atomic EIP-712 settlement discloses both offers and settles at the midpoint. Admission is decided by ERC-8004 reputation through `ReputationGate`.

The package is built from the reference code in the Sealed repository (`agents/sealed`, `agents/relay`), bundled so it stands alone. Its encoders are tested against the deployed contract: they reproduce every commitment of negotiation #4 on Monad testnet and the contract's own settlement digest.

## Install

```bash
npm install sealed-monad
```

Node 20 or later. Runtime dependencies: `ethers` 6, `express` 5 (party server), `@modelcontextprotocol/sdk` and `zod` (MCP server).

## SDK in ten lines

```ts
import { createReadClient, commitmentHash, newSalt, sealedDomain } from "sealed-monad";

const sealed = createReadClient(); // Monad testnet over its public RPC; pass { rpcUrl } to change it
const n = await sealed.getNegotiation(4n);
console.log(n.status, n.settledPrice); // "Settled" 4190n

const salt = newSalt(); // fresh every round; never log it, never reuse it
const commitment = commitmentHash({ domain: sealedDomain(), negotiationId: 4n, party: n.buyerWallet,
  commitIndex: n.buyerCommitIndex + 1, position: { offer: 4200n, salt } });

const report = await sealed.verifySettlement("0xb4f7adf14c5253ce89e16dd33f7d81365819262e6510148b4dbeb70fd88ce498");
console.log(report.ok, report.checks.length); // true 18
```

`commitmentHash` makes no network call. You send `commitment` with `commitOffer(negotiationId, commitment)` from your agent's own wallet; the offer and the salt stay with your agent until settlement.

## Public API

**Commitments and authorizations**

| Export | What it does |
|---|---|
| `commitmentHash({ domain, negotiationId, party, commitIndex, position })` | `keccak256(domainSeparator, negotiationId, party, commitIndex, offer, salt)`, equal to the contract's `commitmentHash` |
| `newSalt()`, `assertSalt(salt)` | 32 bytes of fresh entropy; the check that a salt is 32 bytes |
| `domainSeparator(domain)`, `sealedDomain(deployment?)` | EIP-712 domain separator; the `{ chainId, verifyingContract }` of a deployment (Monad testnet by default) |
| `settleAuthorizationTypedData(domain, message)` | Typed data for `signTypedData`, for the `SettleAuthorization` each agent signs every round |
| `settleAuthorizationDigest(domain, message)` | The digest, equal to the contract's `settleAuthorizationDigest(id)` for the current pair |
| `SETTLE_AUTHORIZATION_TYPES`, `SEALED_EIP712_DOMAIN_NAME`, `SEALED_EIP712_DOMAIN_VERSION` | The EIP-712 types and domain name ("Sealed") and version ("1") |

**Addresses and ABIs**

| Export | What it does |
|---|---|
| `MONAD_TESTNET` | Chain id 10143, public RPC, `SealedNegotiation`, `ReputationGate`, the ERC-8004 Identity and Reputation registries, and the demo admission policy |
| `SEALED_NEGOTIATION_ABI`, `REPUTATION_GATE_ABI` | Full human-readable ABIs, checked against the compiled contracts. ethers: `new Interface(abi)`; viem: `parseAbi(abi)` |
| `IDENTITY_REGISTRY_ABI`, `REPUTATION_REGISTRY_ABI` | The ERC-8004 functions and event Sealed reads or writes |

**Read client** (`createReadClient(options?)` returns a `SealedReader`; no keys)

| Method | What it returns |
|---|---|
| `getNegotiation(id)` | Status (`None`, `Open`, `Locked`, `Settled`, `Expired`), wallets, agent ids, current commitments and commit indices, deadline, settled price, terms hash. Fields a later contract version appends come back raw in `extra` |
| `getCommitIndices(id)` | `{ buyer, seller }`; a side's next commit is its index plus one |
| `checkAdmission(agentId, { wallet?, policy? })` | Whether the wallet is the agent's ERC-8004 wallet, whether the agent clears the policy in `ReputationGate`, and both together (`admitted`) |
| `readReputation(agentId, { reviewers?, tag1?, tag2? })` | ERC-8004 `getSummary` over the trusted reviewers: count, average, decimals |
| `verifySettlement(txHash, { lookbackBlocks? })` | Every check below, each with pass or fail |
| `negotiationCount()` | Number of negotiations opened |

`verifySettlement` needs only the settlement hash. It decodes the settle calldata, recomputes both commitments from the disclosed offers and salts and compares them with the stored ones and with the contract's own `commitmentHash`, checks the EIP-712 domain and digest, recovers both signers, checks that the offers cross, that `NegotiationSettled` carries the midpoint and that the contract recorded it, and finds the two final `commitOffer` transactions to check that each was sent by its party and carried only the negotiation id and the hash. It walks back from the settlement in 100-block `eth_getLogs` windows, the most Monad's public RPC serves, 3,000 blocks by default.

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

Your agent commits on-chain with its own key in `commit`, signs in `authorize`, and decides when to stop. The relay never holds a key that can sign for it. `scripts/agent-process.ts` in the repository is a complete agent process built this way.

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
| `get_negotiation` | `negotiationId` | Status, parties, agent ids, commitments, commit indices and next indices, deadline, settled price |
| `check_admission` | `agentId`, optional `wallet` and `policy` | Wallet check, policy check, `admitted` |
| `read_reputation` | `agentId`, optional `reviewers`, `tag1`, `tag2` | Count and average of ERC-8004 reviews from those reviewers |
| `compute_commitment` | `negotiationId`, `party`, `commitIndex`, `offer`, `salt`, optional `chainId`, `verifyingContract` | The commitment and domain separator, computed locally |
| `verify_settlement` | `txHash`, optional `lookbackBlocks` | Every check of `verifySettlement`, with pass or fail |
| `describe_protocol` | none | How Sealed works, the addresses, the demo policy |

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
npm test          # builds, then unit tests, the party server, and an MCP stdio smoke test, offline
npm run live      # verify_settlement and get_negotiation against Monad testnet through the MCP server
```

At the repository root, `npx hardhat test test/sdk.test.ts` deploys the contracts locally and checks the encoders, the ABIs and the read client against them.

## License

MIT
