# Agent wallets

## The problem an autonomous negotiator creates

A negotiator agent has to sign without a human in the loop. That is the whole
point: two firms' agents settle terms in seconds, not when someone approves a
wallet popup. But an agent that can sign anything, driven by a model that can be
prompted, is a drainable key with a language interface attached.

So Sealed does not ask the agent to behave. It bounds what the key is capable of.

## What the agent can and cannot do

A negotiator can run on a Privy wallet (negotiation #8 and v2 negotiation #6
did; the other demo runs use local keys), whose private key lives in Privy's secure
enclave and is never seen by this backend, by the agent, or by the model. The
backend holds an authorization key that lets it *request* signatures, and every
request is evaluated against a policy before the enclave signs.

The policy ([`agents/privy/mandate.ts`](../agents/privy/mandate.ts)) is a short list
of ALLOW rules, built as data by `buildMandateRules` and tested in
[`test/mandate.test.ts`](../test/mandate.test.ts). Privy denies everything no rule
matches:

**Transactions.** Destination must equal the deployed `SealedNegotiation`
address, chain id must be Monad testnet (10143), and attached value must be
zero. The two exceptions are a call to `register` on the ERC-8004 Identity
Registry, so the agent can create its own identity, and a call to
`giveFeedback` on the ERC-8004 Reputation Registry, so it can rate the other
party after a deal; each rule pins the function name, so nothing else on
either registry is reachable (not `approve`, not `revokeFeedback`). The
`giveFeedback` rule pins the function, not its arguments: which agent gets
rated, and the settlement hash the review points at, come from code
(`agents/sealed/dealFeedback.ts`), which rates only the other party to a
settlement it has read on-chain. A compromised agent process could still post
reviews of its choosing; it could not move funds or sign anything else.
The agent cannot transfer a token, cannot approve a spender, cannot call a
router, cannot bridge. The same rules apply to `eth_signTransaction` as to
`eth_sendTransaction`, so signing a transaction and broadcasting it elsewhere is
not a way around the mandate.

**Signatures.** `eth_signTypedData_v4` is allowed only when the EIP-712 domain's
`verifyingContract` is that same Sealed address and `chainId` is Monad testnet. This is
the rule that matters most and it is the one people forget. An agent that can
sign arbitrary typed data can be walked into signing a Permit2 approval or a
Seaport order by a counterparty that sounds convincing, and no amount of
transaction allowlisting stops that, because the damage happens off-chain and
lands later. Pinning the domain closes it.

The result is a mandate that holds even when the agent does not. A negotiator
whose model is jailbroken, whose context is poisoned, or whose process is
compromised outright can still only do what the mandate allows: negotiate,
badly, register an identity, write reviews and spend gas on those calls. It
cannot widen the mandate, because the policy and the wallet belong to a 2-of-2
admin quorum its key is not part of (see "Who owns the mandate" below). That is
a bounded loss. It is also, in a regulated setting, the difference between an
agent you can deploy and one you cannot.

## Defence in depth

[`AgentWallet`](../agents/privy/agentWallet.ts) never exposes a generic "sign
this" or "send this transaction" method. Every method builds its own calldata or
typed data from Sealed's own encoders, so a caller cannot smuggle a payload
through. The Privy policy enforces the same restriction independently, from
outside the process. A bug in one is caught by the other.

## Setup

1. In the Privy dashboard, create an app, an authorization key and a key quorum
   for the agent. Put `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, the base64 PKCS8 private
   key in `PRIVY_AUTHORIZATION_KEY` and the quorum id in `PRIVY_KEY_QUORUM_ID`
   in `.env`. That is the agent's key. The demo generates the two admin keys
   itself into `.privy-admin-keys.json` (git-ignored; the agent and relay modules
   never open it, the setup scripts do) and creates the 2-of-2 admin quorum that owns everything else.
2. Deploy and seed Sealed on Monad testnet (`npm run seed:monad`).
3. Run the demo:

   ```bash
   npm run demo:privy
   ```

   It creates the mandate, provisions a buyer and a seller wallet under it, has
   each register its own ERC-8004 identity, sends Privy the mandate probes
   ([`agents/privy/probes.ts`](../agents/privy/probes.ts)), and then runs a
   negotiation. The transcript is written to `demo-runs/`.

   `npm run probes:privy` sends only the probes, to the wallets the demo
   created: seventeen requests. Eleven are signing requests a hijacked agent
   would try, which the mandate must refuse with `policy_violation`; three are
   owner actions tried with the agent's key (rewrite the mandate, take the
   wallet back, export its key), which Privy must refuse because the agent's key
   is not the owner; three are what a negotiator really signs, which Privy must
   sign. Any other error is reported as inconclusive, recorded nowhere, and
   stops the script before any negotiation. Nothing a probe gets signed is
   broadcast: the transaction uses nonce 0, long spent, and the authorization
   covers two zero commitments.

## What happened on Monad testnet (2026-10-09)

| Step | Result |
|---|---|
| Mandate | policy `ne7rynh2rknj5jw930p9wsq7`; since the key split, owned by the 2-of-2 admin quorum `r3l0o9erzvtd7corjl3dw07d` |
| Buyer wallet | `0xEA2A77A82636469c4C16801A1Ff8D897B8aBEcb6`, registered itself as ERC-8004 agent [#2093](https://testnet.monadvision.com/tx/0x07df4b4db8d9ad53f6223fabaf4da7b124ace812b1be3dfcb6bdd7157635a37f) |
| Seller wallet | `0xBf96683620d6Bb224dC46774E73125970EA5B2C4`, registered itself as ERC-8004 agent [#2094](https://testnet.monadvision.com/tx/0xe149f2b8c2fa69cbb7cc630f263a7a83ab225e74d4765886b8193f789efd33fe) |
| `eth_sendTransaction`, 1 wei to the relayer | refused: `RPC request denied due to policy violation`, `policy_violation` |
| `eth_signTransaction`, the same transfer | refused, same response |
| `eth_signTypedData_v4`, a Permit2 `PermitSingle` | refused, same response |
| `eth_signTransaction`, a call to `SealedNegotiation` carrying 1 wei | refused, same response |
| `eth_signTransaction`, a call to `SealedNegotiation` with chain id 1 | refused, same response |
| `eth_signTransaction`, ERC-721 `approve` on the Identity Registry | refused, same response |
| `eth_signTypedData_v4`, a Sealed `SettleAuthorization` for a lookalike contract | refused, same response |
| `eth_signTypedData_v4`, a Sealed `SettleAuthorization` for the real contract on chain 1 | refused, same response |
| `personal_sign`, a free-text login message | refused, same response |
| `eth_sign7702Authorization`, delegating the wallet to another address | refused, same response |
| `eth_signTransaction`, `expire` on `SealedNegotiation`, zero value, never broadcast | signed |
| `eth_signTypedData_v4`, a Sealed `SettleAuthorization` through `AgentWallet` | signed |
| `eth_signTransaction`, `revokeFeedback` on the Reputation Registry | refused, same response |
| `eth_signTransaction`, `giveFeedback` on the Reputation Registry, never broadcast | signed |
| `giveFeedback` rule added to the live policy in place (`scripts/privy-feedback-rule.ts`), then each wallet rated the other for #8 | [`0xfc16495a…`](https://testnet.monadvision.com/tx/0xfc16495a4cfd9580718d6ea145b30ddb320e4acaa83ed396921f4f0ad8d433e2) and [`0xa1bc0f3d…`](https://testnet.monadvision.com/tx/0xa1bc0f3d8f8e10870b5c22b8a21dfd2849b86ba9b4ed9c8a85393e89b42264c5), each with the settlement as `feedbackHash` |
| Key split (`scripts/privy-split-keys.ts`), rehearsed first on a throwaway wallet: policy and both wallets handed to the 2-of-2 admin quorum; the agent's quorum `ahcrhijd15jn2umg1xe7dsy4` stays on each wallet as an additional signer held to the mandate | agent key still signs a settlement authorization; the agent key alone, or one admin key alone, cannot change the wallet; both admin keys can |
| All probes re-sent after the split: the eleven signing refusals and three allowed signatures above again, plus `policies.createRule` adding a transfer rule, `wallets.update` setting the owner to the agent's quorum, and `wallets.exportPrivateKey`, all three with the agent's key | the three owner actions refused with 401 `No valid authorization signatures were provided`; 14 refused, 3 signed, 0 inconclusive |
| Negotiation #8, Qwen 3.8 Max agents, every commit and authorization signed by Privy (before the key split) | settled at 4180 (4220 against 4140) in [`0x4eb1de94…`](https://testnet.monadvision.com/tx/0x4eb1de947e2d358c7badaf2c1eb72bce28d67ea84a95eaf8a6b06892a37c4bbf) |
| Mandate extended to the v2 contract by the admin quorum (`scripts/privy-contract-rule.ts`): the same three Sealed rules for `0xb9D7c55f…` | policy at 10 rules; the rules for the first contract stay |
| v2 negotiation #6, after the key split, Qwen 3.8 Max agents, every commit and authorization signed by Privy with the agent's key as an additional signer | settled at 4200 (4250 against 4150) in [`0xba15e68f…`](https://testnet.monadvision.com/tx/0xba15e68f6c9d8a642bfdf96cb26db3a3d8a9a15de8c916a56e58ae8ea38b85d6); both wallets rated each other in ERC-8004 |

The raw responses are in [`deployments/privy-monadTestnet.json`](../deployments/privy-monadTestnet.json)
and the negotiation in [`demo-runs/monadTestnet-privy-deal-8.json`](../demo-runs/monadTestnet-privy-deal-8.json).
Privy broadcast every transaction itself on Monad testnet; the `self` fallback was not needed.

Three things only the live service showed, each now fixed: Privy rejects a
policy whose rule names reach 50 characters (`invalid_policy_format`, now covered
by a test); right after a wallet is funded, Privy's node can still report the
old balance and refuse a broadcast, which the wallet now retries briefly; and
the typed-data request is JSON, so a bigint chain id made the SDK throw
(covered by `test/agentWallet.test.ts`). An earlier attempt, negotiation #7,
stopped at that last error in round 1 and expired with nothing revealed.

If Privy does not broadcast on Monad testnet, set `PRIVY_BROADCAST=self`: Privy
still signs under the same mandate and this process broadcasts the signed
transaction.

## Who owns the mandate

Changing the mandate, or exporting a wallet, is a privileged action, so the
agent's key must not be able to do it. Until 2026-10-09 it could: one 1-of-1
key quorum owned the policy and both wallets, and the agent signed with that
same key, so a compromised agent process could have rewritten its own mandate.
A reviewer pointed it out, and `scripts/privy-split-keys.ts` fixed it on the
live deployment:

- a 2-of-2 admin quorum owns the policy and both wallets; its keys live in a
  git-ignored file that only the Privy setup scripts open (`privy-demo.ts`
  does, in the same process that then runs a negotiation);
- the agent's own quorum is on each wallet only as an additional signer, held
  to the mandate policy, so it signs negotiations and nothing else;
- the recorded probes show the agent's side: with the agent's key, Privy
  refuses to add a rule, to hand the wallet back and to export its key. With
  both admin keys it accepts, which is how the mandate was extended to the
  second contract (`scripts/privy-contract-rule.ts`; `mandateContracts` in
  `deployments/privy-monadTestnet.json` lists both). The refusal with one
  admin key alone was seen in the split rehearsal on a throwaway wallet and
  is not among the recorded probes.

In this demo one operator holds both admin keys. In production they belong to
two different people or HSMs, so widening an agent's permissions takes two
approvals while its day-to-day signing takes none. The thing that happens
thousands of times is autonomous, and the thing that changes what "autonomous"
means is not.
