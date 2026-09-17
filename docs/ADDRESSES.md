# Addresses and network information

## ERC-8004 canonical registries

Sealed does not deploy its own identity or reputation registries. The ERC-8004 team
deployed singletons per chain at CREATE2 vanity addresses, audited by Cyfrin,
Nethermind and the Ethereum Foundation Security Team. Sealed reads those.

| Registry | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| ValidationRegistry | not deployed yet | not deployed yet |

Sources: [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts),
[Monad docs, ERC-8004 guide](https://docs.monad.xyz/guides/erc-8004).

The Validation Registry is not deployed on Monad. Sealed does not depend on it.

## Monad testnet

| | |
|---|---|
| Chain ID | 10143 |
| RPC | `https://testnet-rpc.monad.xyz` |
| Explorer | https://testnet.monadexplorer.com |
| Faucet | https://faucet.monad.xyz |
| Currency | MON |

## Sealed deployments

Filled in as they happen.

| Contract | Network | Address |
|---|---|---|
| ReputationGate | Monad testnet | pending |
| SealedNegotiation | Monad testnet | pending |
