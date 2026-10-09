# Does sealing change the price? A small measurement

Run on 2026-10-09 with `scripts/leak-experiment.ts`, on a local Hardhat network
(fresh contracts and ERC-8004 registries per run, reputation seeded like the
Monad demo), with Qwen 3.8 Max on both sides. Same deal every time: buyer limit
4300, seller limit 4100, reference 4000, three rounds, settlement at the
midpoint. One JSON per run in this folder, with every offer, note and tool call.

| Condition | What changes | Runs | Deals | Mean price | Range |
|---|---|---|---|---|---|
| sealed | the normal flow: neither side sees the other's numbers | 5 | 5 | 4188.8 | 4175 to 4202 |
| open | each agent sees the other's offers from earlier rounds, as on a public chain or with plain commit-reveal | 6 | 4 | 4190.5 | 4175 to 4200 |
| leaked-limit | sealed, but the seller's model is told the buyer's limit, 4300 | 6 | 5 | 4186.0 | 4155 to 4215 |

Three runs aborted (open 1, open 2, leaked-limit 1) because the seller's calls to
Qwen timed out three times in a round; the relay failed closed and nothing was
revealed. They are kept, labelled, and runs 6 replaced two of them.

## What it shows

- **The price did not move.** With these two agents, settling in the open or
  with the buyer's limit leaked ended at the same price as sealed, within a
  few cents. Both agents negotiate conservatively and the midpoint rule splits
  what is left.
- **The seller's behaviour did move.** Told the buyer's limit, the seller opened
  at 4260 to 4290, just under 4300, in every run; without it, it opened at 4600
  to 5000. It anchored on the leaked number, which is the behaviour reported by
  Zhu et al. (arXiv 2506.00073, section 4.1). The buyer's slow climb absorbed it
  here.
- **Limits were published either way.** In some runs a seller's last offer was
  its exact floor (4100), and settlement publishes both final offers. Keeping
  the agents short of their limits is the prompt's job, not the protocol's.

## What it does not show

- Five or six runs per condition, one model on both sides, one set of limits:
  this is our own harness, not a field study, and it cannot tell a small effect
  from none.
- It says nothing about weaker or more aggressive agents, where the cited
  benchmark found buyers paying more once their budget was known.
- So we do not claim that Sealed saves money. What it guarantees is structural:
  until settlement the numbers exist on-chain only as hashes, the counterparty
  learns one bit per round, and a negotiation that does not cross publishes no
  offer at all.

Reproduce one run:

```bash
CONDITION=leaked-limit RUN_IDS=7 npx hardhat run scripts/leak-experiment.ts --network hardhat
```
