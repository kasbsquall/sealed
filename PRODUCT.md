# Product
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Primary, for the judge page: judges of Monad Metropolis, Track 04 (Trust, Identity & AI Infrastructure), and the judges of the Privy and Qwen bounties. They give each project well under a minute, have no wallet connected, and decide whether the claim is real and whether it is infrastructure other Monad applications could build on.

Product users after the event: API and data sellers that sell volume to buying agents, and builders of AI agents that buy services with a budget set by a person (the principal).

## Product Purpose
Sealed lets an AI agent negotiate a price without showing the other side its budget first. If the seller's agent sees the buyer's maximum, it charges the maximum. Success for the page: a judge understands that sentence, sees a real negotiation happen on Monad testnet, and can check every step on MonadVision.

## Positioning
Sealed-bid price negotiation between two agents on Monad: agents are admitted by their ERC-8004 reputation, offers are committed as hashes, a referee (the clearing relay) answers only whether they crossed, settlement is one atomic transaction at the midpoint, and a failed negotiation publishes no offer. Each agent can sign through a Privy wallet whose policy only reaches the Sealed contract.

## Operating Context
Judges open the public repo (github.com/kasbsquall/sealed) and the judge page. Every claim links to a MonadVision transaction. `npm run verify:run` re-derives hashes from the committed transcripts in `demo-runs/`.

## Capabilities and Constraints
- Contracts on Monad testnet, verified on Sourcify (exact match): SealedNegotiation `0xAdBd2619c8f51873B6dB131843cce3403E0869dD`, ReputationGate `0xD7c68cd2197124A7BF3a27467917aBCB982Cc04A`, reading the canonical ERC-8004 registries.
- Agents decide with Qwen (hosted Qwen 3.8 Max, or a local Qwen through Ollama); code clamps every number to the principal's limit.
- The referee sees both numbers of a round that does not cross; it holds no agent key and cannot forge a deal. This is stated on the page, not hidden.
- The page is a static export (Next.js 16) built only from committed files.
- Testnet only. The 0.25% fee is a plan, not implemented in the contracts.

## Brand Commitments
- Name: Sealed.
- Binding (user, 2026-10-08): the Cruce isotipo (two asymmetric crossing lines, square caps, a small square where they cross) and signal orange `#FF4F1A` used only at the settlement point.
- Voice: plain, exact, no hype; every number with its unit; limits stated.
- No emojis anywhere.

## Evidence on Hand
- Deployment and seeded reputation on Monad testnet (`deployments/monadTestnet.json`): agents 2084, 2085, 2086; the gate admits 2084 and 2085 and refuses 2086.
- Negotiation #1: scripted, no model, settled at 4115.
- 51 tests, `docs/ADDRESSES.md` with every transaction.
- Pending: negotiations with Qwen 3.8 Max agents, Privy wallets with refused probes.
- Absent and not to be fabricated: users, customers, pilots, testimonials, mainnet volume, audits.

## Product Principles
1. Proof before claim: every statement on the page is one click from its transaction.
2. Say the limit next to the claim it limits.
3. One sentence of pain before any mechanism.
4. The judge never needs a wallet, an install or an account.

## Accessibility & Inclusion
WCAG AA contrast, keyboard reachable controls, reduced motion respected; the page must work at 390 px wide.
