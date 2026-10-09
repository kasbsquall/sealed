# Why negotiate, and why sealed

Sealed has no users yet. This page collects what others have published about
the problem it addresses, so a reader can judge the demand without taking our
word for it. Every source was opened on 2026-10-09; quotes are kept short.

## Agents are about to haggle over prices

- Forrester's 2026 B2B predictions (28 Oct 2025): "Twenty percent of B2B sellers
  will be forced to engage in agent-led quote negotiations," answered by seller
  agents with generated counteroffers.
  [forrester.com](https://www.forrester.com/press-newsroom/forrester-b2b-marketing-sales-product-2026-predictions/)
- Gartner (21 Oct 2025) predicts that by 2028, 90% of B2B buying will be
  intermediated by AI agents.
  [gartner.com](https://www.gartner.com/en/newsroom/press-releases/2025-10-21-gartner-unveils-top-predictions-for-it-organizations-and-users-in-2026-and-beyond)
- Data and API volume is negotiated by hand today. Market-data APIs publish
  prices for small plans and send large buyers to sales: Databento, Alpha
  Vantage, Twelve Data, CoinGecko, Intrinio, EODHD, Financial Modeling Prep,
  Massive (formerly Polygon.io), and OpenAI's own API for enterprise. The two
  largest data marketplaces have a product just for negotiated prices: AWS Data
  Exchange private offers "can be different from other offers in any dimension,
  including price"
  ([docs](https://docs.aws.amazon.com/data-exchange/latest/userguide/private-offer-configuration.html)),
  and Snowflake Marketplace private offers let consumers negotiate terms
  ([docs](https://docs.snowflake.com/en/user-guide/collaboration/listings/pricing-plans-offers/providers-pricing-plans-offers)).

## The agent payment stack pays a price; nothing sets it

- x402 (Coinbase): the server states the amount and the client picks one of the
  payment requirements it was offered; the specification does not cover
  negotiation. Its site showed 75.41M transactions and $24.24M of volume over
  the last 30 days when we read it.
  [spec](https://github.com/coinbase/x402), [x402.org](https://www.x402.org/)
- AP2 (Google) lists "price negotiation" among what agents will do, and its
  checkout mandate records the negotiated result; the documents we read define
  no mechanism for reaching it.
  [overview](https://github.com/google-agentic-commerce/AP2/blob/main/docs/overview.md)
- Agentic Commerce Protocol (OpenAI and Stripe): the merchant returns the
  authoritative cart state; a proposed RFC frames buyer-agent feedback as a
  step toward "deterministic negotiation (bidding)", by having the buyer tell
  the merchant why it walked away, which hands the seller information.
  [RFC](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/rfcs/rfc.intent_traces.md)
- ERC-8004 gives agents identity and reputation and leaves payments out of
  scope ([EIP-8004](https://eips.ethereum.org/EIPS/eip-8004)). On Monad mainnet
  its Identity Registry had issued 10,328 agent ids when we read its counter on
  2026-10-09 (next id 10328; `ownerOf(10327)` exists, `ownerOf(10328)` reverts).
  That counts registrations, not active agents.

Sealed sits in that gap: it settles the price both agents' limits allow, and a
payment rail or a mandate can carry the result.

## Agents leak their limits when they negotiate in the open

- In a benchmark of agent-to-agent negotiation, buyer agents told not to
  disclose their budget still did: "many buyer agents reveal their budget
  easily", and sellers then anchored offers to that number, so buyers paid more.
  Zhu et al., arXiv 2506.00073, section 4.1.
  [arxiv.org](https://arxiv.org/html/2506.00073v4)
- In Microsoft Research's Magentic Marketplace, prompt injection between agents
  "often redirect all payments to manipulative agents" for several models.
  Bansal et al., arXiv 2510.25779, section 5.3.
  [arxiv.org](https://arxiv.org/html/2510.25779v1)
- In NegotiationArena, the first number anchors the final price, and agents
  tend to split the difference on their own, which is what Sealed's midpoint
  settlement makes explicit. Bianchi et al., arXiv 2402.05863.
  [arxiv.org](https://arxiv.org/html/2402.05863)

Sealed removes the channel those failures use: until settlement, an agent's
number exists for the counterparty only as a salted hash, and the only thing
the agents learn from each other per round is one bit, crossed or not. The
injection runs in [QWEN.md](QWEN.md) show the other half: text the counterparty
wrote reaches the model labelled as such, and code keeps every committed number
inside the limit.

## What this page does not show

- No study we found measures how much more a buyer pays when the seller knows
  its limit; the benchmark above describes it without a rate.
- The crossed or not bit is itself a signal. A July 2026 preprint shows a
  budget can be inferred from a negotiation's concession pattern alone (Rani,
  arXiv 2607.06815, synthetic data). Sealed reduces that channel to one bit per
  round, over at most a few rounds; it does not remove it.
- None of the sources above is a customer. The first measure of demand is a
  pilot with an API seller, which Sealed does not have yet.
