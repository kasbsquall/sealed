# Agent wallets

## The problem an autonomous negotiator creates

A negotiator agent has to sign without a human in the loop. That is the whole
point: two firms' agents settle terms in seconds, not when someone approves a
wallet popup. But an agent that can sign anything, driven by a model that can be
prompted, is a drainable key with a language interface attached.

So Sealed does not ask the agent to behave. It bounds what the key is capable of.

## What the agent can and cannot do

Each negotiator runs on a Privy wallet whose private key lives in Privy's secure
enclave and is never seen by this backend, by the agent, or by the model. The
backend holds an authorization key that lets it *request* signatures, and every
request is evaluated against a policy before the enclave signs.

The policy ([`agents/privy/mandate.ts`](../agents/privy/mandate.ts)) is two ALLOW
rules, and Privy denies everything no rule matches:

**Transactions.** Destination must equal the deployed `SealedNegotiation`
address, chain id must be Monad, and attached value must be zero. Nothing else
is reachable. The agent cannot transfer a token, cannot approve a spender,
cannot call a router, cannot bridge.

**Signatures.** `eth_signTypedData_v4` is allowed only when the EIP-712 domain's
`verifyingContract` is that same Sealed address and `chainId` is Monad. This is
the rule that matters most and it is the one people forget. An agent that can
sign arbitrary typed data can be walked into signing a Permit2 approval or a
Seaport order by a counterparty that sounds convincing, and no amount of
transaction allowlisting stops that, because the damage happens off-chain and
lands later. Pinning the domain closes it.

The result is a mandate that holds even when the agent does not. A negotiator
whose model is jailbroken, whose context is poisoned, or whose process is
compromised outright can still only do one thing: negotiate, badly. That is a
bounded loss. It is also, in a regulated setting, the difference between an
agent you can deploy and one you cannot.

## Defence in depth

[`AgentWallet`](../agents/privy/agentWallet.ts) never exposes a generic "sign
this" or "send this transaction" method. Every method builds its own calldata or
typed data from Sealed's own encoders, so a caller cannot smuggle a payload
through. The Privy policy enforces the same restriction independently, from
outside the process. A bug in one is caught by the other.

## Setup

1. In the Privy dashboard, create an authorization key and a key quorum that
   owns it. Store the base64 PKCS8 private key in `PRIVY_AUTHORIZATION_KEY` and
   the quorum id in `PRIVY_KEY_QUORUM_ID`.
2. Deploy `SealedNegotiation` (see [ADDRESSES.md](ADDRESSES.md)).
3. Create the mandate and provision the two demo wallets:

   ```bash
   npx tsx agents/scripts/setupAgents.ts 0xYourSealedAddress
   ```

4. Register each printed address as the `agentWallet` of its ERC-8004 agent id
   in the Identity Registry. `ReputationGate` checks exactly that binding, so an
   agent cannot quote reputation that belongs to someone else.

## Why key quorums

Changing the mandate, or exporting a wallet, is a privileged action. Those are
owned by a key quorum rather than a single key, so widening an agent's
permissions takes multi-party approval. The agent's day-to-day signing does not.
The split matters: the thing that happens thousands of times is autonomous, and
the thing that changes what "autonomous" means is not.
