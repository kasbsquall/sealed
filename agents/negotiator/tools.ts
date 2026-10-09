import type { ToolDefinition } from "../llm/client";

/** The move the model chose for a round. The number is chosen alongside it. */
export const STANCES = ["open-with-room", "concede", "hold", "final-at-limit"] as const;
export type Stance = (typeof STANCES)[number];

/**
 * The tools a negotiator's model can call during a round. Three read and one
 * acts. None of them can reach the counterparty's number, which is sealed, and
 * the only one that acts goes through the same mandate checks as before.
 */
export const NEGOTIATOR_TOOLS: ToolDefinition[] = [
  {
    name: "read_negotiation",
    description:
      "Reads this negotiation: the round, rounds left, its on-chain status and seconds to the deadline, and your own earlier offers and notes. Never the counterparty's offers, which are sealed.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "read_counterparty_reputation",
    description:
      "Reads the counterparty agent's reputation from the ERC-8004 Reputation Registry on-chain, counting only reviewers your principal trusts: number of reviews and their average.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "check_offer",
    description:
      "Checks a candidate number without committing it: whether the rules allow it, how far it is from the reference price and from your limit, and what you would pay or receive if it crosses.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["offer"],
      properties: { offer: { type: "integer", description: "Candidate number, in the unit of the negotiation." } },
    },
  },
  {
    name: "submit_offer",
    description:
      "Submits this round's sealed number and ends your turn. It is checked against your mandate; if it is rejected you get the reason and can submit again.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["stance", "offer", "note"],
      properties: {
        stance: { type: "string", enum: [...STANCES] },
        offer: { type: "integer", description: "This round's sealed number, in the unit of the negotiation." },
        note: {
          type: "string",
          description: "Short note for yourself in later rounds: your plan in round 1, and whether you are following it afterwards.",
        },
      },
    },
  },
];
