"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowsInLineHorizontal,
  ArrowsLeftRight,
  ArrowsOutLineHorizontal,
  Brain,
  Cube,
  FlagCheckered,
  HandPalm,
  Intersect,
  ListChecks,
  Lock,
  Pause,
  SealCheck,
  type Icon,
} from "@phosphor-icons/react";
import type { Round, Run, Side } from "@/lib/data";
import { STANCE_LABEL, addressUrl, dollars, inDollars, short, txUrl, utc } from "@/lib/format";
import { meetLabel } from "@/lib/view";
import { LinkOut } from "../LinkOut";
import { Stamp } from "../replay/Typed";
import { LiveLine } from "./LiveLine";
import { useLiveStatus, type Live } from "./useLiveStatus";

const STANCE_ICON: Record<string, Icon> = {
  "open-with-room": ArrowsOutLineHorizontal,
  concede: ArrowsInLineHorizontal,
  hold: Pause,
  "final-at-limit": FlagCheckered,
};

const splitExplanation = (text: string) => {
  const [first, ...rest] = text.split(/(?<=\.)\s+/);
  return { move: inDollars(first), correction: rest.length ? inDollars(rest.join(" ")) : undefined };
};

/** Arrow keys, Home and End over the tabs, per the WAI-ARIA tabs pattern. */
function nextIndex(key: string, current: number, count: number): number | undefined {
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

/**
 * Both negotiations as filed forms. The tabs pick the order; the lens is a
 * pair of native radios read by CSS, so it works before and without
 * JavaScript, and without JavaScript both orders are simply shown.
 */
export function Record({ runs }: { runs: Run[] }) {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const live = useLiveStatus(runs);

  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextIndex(event.key, active, runs.length);
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="record">
      <div className="otabs" role="tablist" aria-label="Negotiation">
        {runs.map((r, i) => (
          <button
            key={r.negotiationId}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`otab-${r.negotiationId}`}
            className="otab"
            aria-selected={i === active}
            aria-controls={`order-${r.negotiationId}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={onKey}
          >
            {r.outcome === "settled" ? (
              <Intersect size="1.1em" weight="light" aria-hidden />
            ) : (
              <ArrowsLeftRight size="1.1em" weight="light" aria-hidden />
            )}
            {r.outcome === "settled" ? "Deal" : "No deal"} <b>#{r.negotiationId}</b>
          </button>
        ))}
      </div>
      <div className="paper doc rec-doc">
        <div className="doc-top">
          <fieldset className="lens">
            <legend>Read this order as</legend>
            <label>
              <input type="radio" name="lens" value="knew" defaultChecked />
              <Brain size="1.1em" weight="light" aria-hidden />
              What each agent knew
            </label>
            <label>
              <input type="radio" name="lens" value="chain" id="lens-chain" />
              <Cube size="1.1em" weight="light" aria-hidden />
              What Monad recorded
            </label>
          </fieldset>
        </div>
        {runs.map((run, i) => (
          <div
            key={run.negotiationId}
            id={`order-${run.negotiationId}`}
            className="rec-panel"
            role="tabpanel"
            aria-labelledby={`otab-${run.negotiationId}`}
            data-active={i === active}
          >
            <Order run={run} live={live[run.negotiationId]} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Order({ run, live }: { run: Run; live: Live | undefined }) {
  const crossedIn = run.rounds.find((r) => r.crossed)?.round;
  return (
    <>
      <div className="r-head">
        <div>
          <span className="lbl">Negotiation</span>
          <span className="r-no">#{run.negotiationId}</span>
        </div>
        <div className="r-meta">
          <div className="fld">
            <span className="lbl">Public reference price</span>
            <span className="ty">{dollars(run.referencePrice)} per 1,000 calls</span>
          </div>
          <div className="fld">
            <span className="lbl">Deadline</span>
            <span className="ty">{utc(run.deadline)}</span>
          </div>
          <div className="fld">
            <span className="lbl">Rounds</span>
            <span className="ty">
              {run.rounds.length}, {crossedIn ? `offers met in round ${crossedIn}` : "offers never met"}
            </span>
          </div>
        </div>
      </div>

      <div className="r-grid">
        <div className="hd">
          <p className="hd-l">Round</p>
        </div>
        <Party run={run} role="buyer" />
        <div className="hd">
          <p className="hd-l">Referee</p>
          <p className="k">Checks each offer against its hash, answers only whether the offers meet</p>
          <p className="c">Runs off-chain; its answers are not recorded on Monad</p>
        </div>
        <Party run={run} role="seller" />
        {run.rounds.map((round) => (
          <RoundRow key={round.round} run={run} round={round} />
        ))}
      </div>

      <Outcome run={run} live={live} />
    </>
  );
}

function Party({ run, role }: { run: Run; role: "buyer" | "seller" }) {
  const agent = run.agents[role];
  return (
    <div className="hd">
      <p className="hd-l">{role === "buyer" ? "Buyer" : "Seller"}</p>
      <p>ERC-8004 agent #{agent.agentId}</p>
      <div className="k">
        <span className="ty">
          {role === "buyer" ? "Will pay at most " : "Will accept no less than "}
          {dollars(agent.limit)} per 1,000 calls
        </span>
        <p>Private to this agent, published here for the demo.</p>
      </div>
      <div className="c">
        <span className="ty">Limit never sent on-chain</span>
        <p>
          Wallet <LinkOut href={addressUrl(agent.wallet)}>{short(agent.wallet)}</LinkOut>
        </p>
      </div>
    </div>
  );
}

function RoundRow({ run, round }: { run: Run; round: Round }) {
  const opened = run.outcome === "settled" && round.round === run.rounds.at(-1)?.round;
  return (
    <>
      <div className="rc">
        <span className="rn">
          <small>Round</small>
          {round.round}
        </span>
      </div>
      <SideCell run={run} side={round.buyer} role="Buyer" opened={opened} />
      <div>
        <span className="mlbl">Referee</span>
        <div className="k">
          <span className="verdict">
            {round.crossed ? (
              <Intersect size="1.1em" weight="light" aria-hidden />
            ) : (
              <ArrowsLeftRight size="1.1em" weight="light" aria-hidden />
            )}
            {meetLabel(round.crossed)}
          </span>
          <p className="why">{round.crossed ? "The buyer offers at least what the seller asks" : "Both sides learn only this"}</p>
        </div>
        <div className="c">
          <span className="verdict">
            <Lock size="1.1em" weight="light" aria-hidden />
            Off-chain
          </span>
          <p className="why">The referee&apos;s answer is not recorded</p>
        </div>
      </div>
      <SideCell run={run} side={round.seller} role="Seller" opened={opened} />
    </>
  );
}

function SideCell({ run, side, role, opened }: { run: Run; side: Side; role: string; opened: boolean }) {
  const StanceIcon = STANCE_ICON[side.stance] ?? Pause;
  const { move, correction } = splitExplanation(side.explanation);
  return (
    <div>
      <span className="mlbl">{role}</span>
      <div className="k">
        <span className="px">{dollars(side.offer)}</span>
        <p className="stance">
          <StanceIcon size="1.1em" weight="light" aria-hidden />
          Model&rsquo;s own label: {STANCE_LABEL[side.stance] ?? side.stance}
          {side.correction ? ", overridden" : ""}
        </p>
        <p className="why">{move}</p>
        {side.steps?.length ? (
          <p className="steps">
            <ListChecks size="1.1em" weight="light" aria-hidden />
            <span>{describeSteps(side.steps, role === "Buyer" ? "seller" : "buyer")}</span>
          </p>
        ) : null}
        {side.note && (
          <details className="note">
            <summary>Model&apos;s note, verbatim, prices in US cents</summary>
            <p>{side.note}</p>
          </details>
        )}
        {correction && (
          <p className="correction">
            <HandPalm size="1.1em" weight="light" aria-hidden />
            <span>{correction}</span>
          </p>
        )}
      </div>
      <div className="c">
        <span className="blk">
          <span className="under" aria-hidden="true">
            {dollars(side.offer)}
          </span>
          <span className="sr">Price not readable on Monad</span>
        </span>
        <p className="cref calldata">
          <span className="sr">Commit transaction input: </span>
          commitOffer({run.negotiationId},{" "}
          <LinkOut href={txUrl(side.commitTx)}>{short(side.commitment, 10, 8)}</LinkOut>)
        </p>
        {opened && (
          <p className="opened">
            <SealCheck size="1.1em" weight="light" aria-hidden />
            Opened by the settlement: {dollars(side.offer)}
          </p>
        )}
      </div>
    </div>
  );
}

/** One line from the round's tool calls, e.g. "Read the negotiation, read the seller's reputation on-chain (4.38 over 6 reviews), checked 2 numbers ($36.00, $37.50), submitted." */
function describeSteps(steps: NonNullable<Side["steps"]>, counterparty: string): string {
  const parts: string[] = [];
  if (steps.some((s) => s.tool === "read_negotiation")) parts.push("read the negotiation");
  const reputation = steps.find((s) => s.tool === "read_counterparty_reputation");
  if (reputation) {
    try {
      const { reviews, average } = JSON.parse(reputation.output);
      parts.push(`read the ${counterparty}'s reputation on-chain (${average} over ${reviews} reviews)`);
    } catch {
      parts.push(`read the ${counterparty}'s reputation on-chain`);
    }
  }
  const checks = steps.filter((s) => s.tool === "check_offer").map((s) => dollars(String(s.input.offer)));
  if (checks.length) parts.push(`checked ${checks.length} ${checks.length === 1 ? "number" : "numbers"} (${checks.join(", ")})`);
  const rejected = steps.filter((s) => s.tool === "submit_offer" && s.output.startsWith("rejected")).length;
  if (rejected) parts.push(`had ${rejected} ${rejected === 1 ? "submission" : "submissions"} rejected by code`);
  parts.push("submitted");
  const sentence = parts.join(", ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}

function Outcome({ run, live }: { run: Run; live: Live | undefined }) {
  const last = run.rounds.at(-1)!;
  const settled = run.outcome === "settled" && run.settledPrice;
  const closingTx = settled ? run.settleTx : run.expireTx;
  const sealedForGood = settled ? run.rounds.length - 1 : run.rounds.length;

  return (
    <div className="r-out">
      <div className="stamp-zone">
        {settled ? (
          <Stamp
            lines={["Settled", dollars(run.settledPrice!), "per 1,000 calls"]}
            label={`Settled at ${dollars(run.settledPrice!)} per 1,000 calls`}
            tone="carbon"
          />
        ) : (
          <Stamp lines={["Expired", undefined, "No offer published"]} label="Expired, no offer published" tone="carbon" />
        )}
      </div>
      <div>
        <p className="big-line">
          {settled
            ? `Settled on Monad testnet at ${dollars(run.settledPrice!)} per 1,000 API calls, halfway between the buyer's ${dollars(last.buyer.offer)} and the seller's ${dollars(last.seller.offer)}`
            : "The offers never met. The negotiation expired with no offer on-chain."}
        </p>
        <p className="k">
          {settled
            ? `The buyer could pay up to ${dollars(run.agents.buyer.limit)} and the seller would take ${dollars(run.agents.seller.limit)} or more. Neither knew the other's limit. They met in round ${last.round}, ${atLimits(run, last)}.`
            : `The buyer could pay at most ${dollars(run.agents.buyer.limit)}; the seller would take no less than ${dollars(run.agents.seller.limit)}. No price satisfies both, so the offers met in none of the ${run.rounds.length} rounds and the negotiation expired at its deadline.`}
        </p>
        <p className="c">
          {settled
            ? `The settlement is the only transaction that carries offers, and only round ${last.round}'s pair. The offers of the other ${sealedForGood} ${sealedForGood === 1 ? "round" : "rounds"} were never made public on-chain.`
            : `The chain recorded ${run.rounds.length * 2} hashes and an expiry. No offer from either side ever appears on Monad.`}
        </p>
        <div className="links">
          {closingTx && (
            <LinkOut href={txUrl(closingTx)}>
              {settled ? "Settlement" : "Expiry"} {short(closingTx)}
            </LinkOut>
          )}
          <LinkOut href={txUrl(run.createTx)}>Created {short(run.createTx)}</LinkOut>
        </div>
        <LiveLine live={live} />
        <p className="nojs-note">The live read needs JavaScript. Every transaction link above opens on MonadVision.</p>
        <p className="model">
          <Brain size="1.1em" weight="light" aria-hidden />
          <span>
            Each agent decided with <span className="mono">{run.model}</span>
            {run.modelHost?.startsWith("local") ? " running locally" : ""}, with only its own limit in view.
            {run.rounds.some((r) => r.buyer.steps?.length)
              ? " Each round the model worked in steps: it read the negotiation and the counterparty's ERC-8004 reputation on-chain, checked candidate numbers, and submitted one with a note it read back in the next round."
              : " The model picks a stance and a number."}{" "}
            Code checks every number against the limit and writes each explanation. Transcript:{" "}
            <span className="mono">{run.file}</span>
          </span>
        </p>
      </div>
    </div>
  );
}

/** How close each final offer came to its limit, computed from the numbers, never assumed. */
function atLimits(run: Run, last: Round) {
  const buyerGap = BigInt(run.agents.buyer.limit) - BigInt(last.buyer.offer);
  const sellerGap = BigInt(last.seller.offer) - BigInt(run.agents.seller.limit);
  if (buyerGap === 0n && sellerGap === 0n) return "when both committed at their limits";
  const side = (gap: bigint, who: string) => (gap === 0n ? `the ${who} at its limit` : `the ${who} ${dollars(gap)} short of its limit`);
  return `with ${side(buyerGap, "buyer")} and ${side(sellerGap, "seller")}`;
}
