# Addresses and network information

Explorer links go to [MonadVision](https://testnet.monadvision.com). Everything here is
also in [`deployments/monadTestnet.json`](../deployments/monadTestnet.json), which the
scripts write as they go.

## ERC-8004 canonical registries

Sealed does not deploy its own identity or reputation registries. The ERC-8004 team
deployed singletons at the same CREATE2 vanity addresses on every supported chain.
Sealed reads those.

| Registry | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

Source: [erc-8004/erc-8004-contracts README](https://github.com/erc-8004/erc-8004-contracts).

Checked on Monad testnet on 2026-10-08: both addresses return ERC-1967 proxy bytecode,
`name()` on the Identity Registry returns `AgentIdentity`, and `getSummary` takes four
arguments and reverts with `clientAddresses required` when the reviewer list is empty.
`npm run check:registries` repeats the check through Sealed's own interfaces.

Sealed does not use the Validation Registry.

## Monad testnet

| | |
|---|---|
| Chain ID | 10143 |
| RPC | `https://testnet-rpc.monad.xyz` |
| Explorer | https://testnet.monadvision.com |
| Faucet | https://faucet.monad.xyz |

Two properties of Monad shape the scripts:

- **Gas is charged on the limit, not on the gas used**, with a base fee of at least 100
  gwei, and a transaction is only accepted if the sender can cover limit times
  `maxFeePerGas` up front. Fees are read from the node in
  [`agents/sealed/fees.ts`](../agents/sealed/fees.ts), and the seed script sizes each
  wallet's gas money from measured limits.
- **The public RPC serves `eth_getLogs` over at most 100 blocks.** Log queries are split
  into ranges in [`scripts/logs.ts`](../scripts/logs.ts).

## Sealed deployment

| Contract | Address | Deploy transaction |
|---|---|---|
| ReputationGate | [`0xD7c68cd2197124A7BF3a27467917aBCB982Cc04A`](https://testnet.monadvision.com/address/0xD7c68cd2197124A7BF3a27467917aBCB982Cc04A) | [`0xf0bf4c07…`](https://testnet.monadvision.com/tx/0xf0bf4c07b5e0c9c9e99fb6e84aa206ad8fe0040464564a9a872f28d7d74c7100) |
| SealedNegotiation | [`0xAdBd2619c8f51873B6dB131843cce3403E0869dD`](https://testnet.monadvision.com/address/0xAdBd2619c8f51873B6dB131843cce3403E0869dD) | [`0x7c059112…`](https://testnet.monadvision.com/tx/0x7c059112973d0be645772a86c6e0bb986798e85d61ec292fe6abd3f625f3ef32) |

Both are verified on [Sourcify](https://sourcify.dev) with an exact match (creation and
runtime bytecode), submitted with `node scripts/verify-sourcify.cjs` on 2026-10-08.

## Demo agents and seeded reputation

The demo reputation below was created by [`scripts/seed-demo.ts`](../scripts/seed-demo.ts)
to exercise the real registries. It is labelled as seeded everywhere and is not evidence
of real-world trust.

| Agent | ERC-8004 id | Wallet | Registered | Seeded reviews | Clears the demo policy |
|---|---|---|---|---|---|
| buyer | 2084 | [`0x22363d16…`](https://testnet.monadvision.com/address/0x22363d16A46cdAa6FC2733d222AE53613b984f1c) | [`0xc5ba1a76…`](https://testnet.monadvision.com/tx/0xc5ba1a76f22edae0b3fadee3d4ae2c5448fc405ec246257b56fd73c113895336) | 6 (4.50 to 4.90) | yes |
| seller | 2085 | [`0x7351f178…`](https://testnet.monadvision.com/address/0x7351f1784e8F63B005E997600a3a0E65020987CC) | [`0xcb07a16a…`](https://testnet.monadvision.com/tx/0xcb07a16adfb853be3295fb3d2b7a516cd4e921e6caccacea40d6860f07ef7d67) | 6 (4.20 to 4.60) | yes |
| newcomer | 2086 | [`0xe5E156e0…`](https://testnet.monadvision.com/address/0xe5E156e0121a730f8D40727C7dc23bBb097d04d5) | [`0x5c1ef28e…`](https://testnet.monadvision.com/tx/0x5c1ef28e831e532a8846e2e1e322816c7cbc9083e4fa66176c023a1d1e58aeee) | 1 (5.00) | no, too few reviews |

Demo policy: at least 5 reviews from the three demo reviewers
([`0xb5d965E7…`](https://testnet.monadvision.com/address/0xb5d965E79E52a5b381D3b475987C897B4F1977e5),
[`0x2C345630…`](https://testnet.monadvision.com/address/0x2C345630e11551fd1b9096e09109CF92767dA8aE),
[`0xF567d58C…`](https://testnet.monadvision.com/address/0xF567d58C1017342a0021d641f803496AC9c38A8f)),
averaging at least 4.00. Every feedback transaction is listed in
[`deployments/monadTestnet.json`](../deployments/monadTestnet.json).

## Live negotiations

| # | What | Outcome | Transactions |
|---|---|---|---|
| 1 | Scripted smoke test, no model: offers 4250 and 3980 chosen by the script; the newcomer is refused by the gate with `NotAdmitted` | settled at 4115 | create [`0x18718903…`](https://testnet.monadvision.com/tx/0x18718903a83015449f09861354094e784b1d5bf5a37a412823b99732554f494d), commits [`0x74f2a1d8…`](https://testnet.monadvision.com/tx/0x74f2a1d88ddb13fa72c270f1a986c96a414216ac349ee5e49f3c606e46e4d825) and [`0x479cd74d…`](https://testnet.monadvision.com/tx/0x479cd74d2e7bf999cc8ad73ff44d06bb73fc0657474b1f541eb83335ebe33909), settle [`0xce6ccd99…`](https://testnet.monadvision.com/tx/0xce6ccd99591b06d46d94fac5bf604b5a7769cb1b58d1312b6b1c395404ac504c) |

| 2 | Deal scenario with Qwen 3.8 Max agents working in steps with tools. Limits: buyer 4300, seller 4100 | settled at 4200 in round 3 (4300 against 4100) | create [`0x49ce3cf9…`](https://testnet.monadvision.com/tx/0x49ce3cf9a8524d7628dbaf4d04b04391a9e5ad16c6a05f610d396a69db5e8f14), settle [`0xd8f6d830…`](https://testnet.monadvision.com/tx/0xd8f6d83081d4cb79347fe63fbb9101f6a17133627e6a7a596f59ab6cfdd7dac1); six commits in [`demo-runs/monadTestnet-deal-2.json`](../demo-runs/monadTestnet-deal-2.json) |
| 3 | No-deal scenario with Qwen 3.8 Max agents. Limits: buyer 3600, seller 4300, so no price satisfies both | expired after three rounds, no offer on-chain | create [`0xf250521e…`](https://testnet.monadvision.com/tx/0xf250521e260db4f8463d065790c70de37c88ecbdecca7a17f91ff69cee75c38e), expire [`0x605ffe8d…`](https://testnet.monadvision.com/tx/0x605ffe8d02cc1d6dfe0ee267d54ed8639c28ee8b72f451b89bee2c741cd8c96a); six commits in [`demo-runs/monadTestnet-no-deal-3.json`](../demo-runs/monadTestnet-no-deal-3.json) |

`RUN=demo-runs/monadTestnet-deal-2.json npm run verify:run` and the same for `monadTestnet-no-deal-3.json` re-derive every hash from the transcript and check it against Monad testnet; both pass.

Negotiation #1 went from creation to settlement in 17 blocks, about 5 seconds by block
timestamps, with the script waiting for each receipt before sending the next transaction.
At 102 gwei a commit (53,957 to 56,234 gas) cost about 0.0056 MON and the settlement
(73,364 gas) about 0.0075 MON.
