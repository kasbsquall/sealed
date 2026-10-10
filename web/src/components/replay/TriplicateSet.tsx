"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Cube, FastForward, MagnifyingGlass, Play, Storefront, User, type Icon } from "@phosphor-icons/react";
import { meetLabel, type OrderRound, type OrderView, type SealedSide } from "@/lib/view";
import { LinkOut } from "../LinkOut";
import { SealMark } from "../SealMark";
import { useReplay, useStatusText } from "./ReplayProvider";
import { DROP_MS, Slot, Stamp, T, TickBox, sequence } from "./Typed";

type Copy = "buyer" | "seller" | "chain";

const COPIES: { id: Copy; n: number; name: string; paper: "w" | "y" | "p"; icon: Icon }[] = [
  { id: "buyer", n: 1, name: "what the buyer saw", paper: "w", icon: User },
  { id: "seller", n: 2, name: "what the seller saw", paper: "y", icon: Storefront },
  { id: "chain", n: 3, name: "what the chain saw", paper: "p", icon: Cube },
];
const ORDER: Copy[] = COPIES.map((c) => c.id);

/** Pause between the last typed line of a settlement and the stamp landing on it. */
const STAMP_LEAD_MS = 140;

/** Arrow keys, Home and End over the filing tabs, per the WAI-ARIA tabs pattern. */
function nextIndex(key: string, current: number, count: number): number | undefined {
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

/**
 * The fanned set of three copies of one negotiation order. Each copy holds
 * what its party could know: the buyer's copy carries the buyer's offers, the
 * seller's copy the seller's, and the chain copy only the commitment hashes,
 * under a security block that carbon cannot pass.
 */
export function TriplicateSet({ order }: { order: OrderView }) {
  const [front, setFront] = useState<Copy>("buyer");
  const [mounted, setMounted] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => setMounted(true), []);

  const stack: Copy[] = [front, ...ORDER.filter((c) => c !== front)];

  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextIndex(event.key, ORDER.indexOf(front), ORDER.length);
    if (next === undefined) return;
    event.preventDefault();
    setFront(ORDER[next]);
    tabs.current[next]?.focus();
  };

  return (
    <div className="set-wrap">
      <div className="copy-tabs" role="tablist" aria-label={`Copies of negotiation order No. ${order.id}`}>
        {COPIES.map((c, i) => (
          <button
            key={c.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${c.id}`}
            className={`ctab paper-${c.paper}`}
            aria-selected={front === c.id}
            aria-controls={`sheet-${c.id}`}
            tabIndex={front === c.id ? 0 : -1}
            onClick={() => setFront(c.id)}
            onKeyDown={onKey}
          >
            <c.icon size="1.1em" weight="light" aria-hidden />
            {c.name.charAt(0).toUpperCase() + c.name.slice(1)}
          </button>
        ))}
      </div>
      <div className="set">
        {COPIES.map((c) => {
          const pos = stack.indexOf(c.id);
          const back = mounted && pos > 0;
          return (
            <article
              key={c.id}
              id={`sheet-${c.id}`}
              className={`sheet paper paper-${c.paper} pos${pos}`}
              data-copy={c.id}
              role="tabpanel"
              aria-labelledby={`tab-${c.id}`}
              inert={back}
              aria-hidden={back || undefined}
            >
              <Sheet order={order} copy={c.id} n={c.n} name={c.name} isFront={pos === 0} />
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Sheet({ order, copy, n, name, isFront }: { order: OrderView; copy: Copy; n: number; name: string; isFront: boolean }) {
  // Exactly one h1 on the page, always on the copy in front.
  const Purpose = isFront ? "h1" : "p";
  const status = `status-${copy}`;
  return (
    <>
      <header className="f-head">
        <div className="f-brand">
          <SealMark ground={`var(--paper-${copy === "buyer" ? "w" : copy === "seller" ? "y" : "p"})`} />
          <span className="wm">Sealed</span>
        </div>
        <div className="f-order">
          <span className="t1">Negotiation order</span>
          <span className="no">No.&nbsp;{order.id}</span>
        </div>
        <dl className="f-copy">
          <div>
            <dt className="lbl">Copy</dt>
            <dd>
              {n} of 3, {name}
            </dd>
          </div>
          <div>
            <dt className="lbl">Network</dt>
            <dd>Monad testnet, chain 10143</dd>
          </div>
        </dl>
      </header>

      <div className="f-strip">
        <Field label="Demo terms" value={order.terms} />
        <Field label="Public reference price" value={order.reference} />
        <Field label="Deadline" value={order.deadline} />
        <Party label="Buyer" agentId={order.buyerId} admitted={order.admitted.buyer} />
        <Party label="Seller" agentId={order.sellerId} admitted={order.admitted.seller} />
      </div>

      <p className="hook">
        <span className="hook-ctx">On a public chain, the other side&rsquo;s agent can read every offer yours makes.</span>
        If the seller sees your maximum, it opens just under it
      </p>

      <div className="f-body">
        <div className="f-left">
          <Purpose className="h1">Your agent can haggle without showing its budget first.</Purpose>
          <p className="instr">
            Each agent locks a hashed offer on Monad. A relay says only whether the offers cross, and one
            transaction settles at the midpoint.
          </p>
          <div className="f-act">
            <ReplayButton id={order.id} describedBy={status} />
            <a className="check-link" href="#verify">
              <MagnifyingGlass size="1.1em" weight="light" aria-hidden />
              Verify it on Monad
            </a>
          </div>
          <Status id={status} />
        </div>

        <div className="f-right">
          <table className="rounds">
            <caption className="sr">
              Sealed rounds of negotiation {order.id} as recorded on the {name}
            </caption>
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col">{columnHead(copy, "buyer")}</th>
                <th scope="col">Relay says only</th>
                <th scope="col">{columnHead(copy, "seller")}</th>
              </tr>
            </thead>
            <tbody>
              {order.rounds.map((r) => (
                <RoundRow key={r.n} round={r} copy={copy} />
              ))}
            </tbody>
          </table>

          <SettleLine order={order} />
        </div>
      </div>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="fld">
      <span className="lbl">{label}</span>
      <span className="ty">{value}</span>
    </div>
  );
}

function Party({ label, agentId, admitted }: { label: string; agentId: string; admitted: boolean }) {
  return (
    <div className="fld">
      <span className="lbl">{label}</span>
      <span className="ty">ERC-8004 agent #{agentId}</span>
      {admitted && (
        <Slot as="span" id="adm" className="adm">
          <TickBox />
          <T text="Admitted by reputation" at={0} />
        </Slot>
      )}
    </div>
  );
}

const owns = (copy: Copy, side: "buyer" | "seller") => copy === side;

function columnHead(copy: Copy, side: "buyer" | "seller") {
  const who = side === "buyer" ? "Buyer offer" : "Seller offer";
  if (copy === "chain") return side === "buyer" ? "Buyer hash" : "Seller hash";
  return owns(copy, side) ? `${who} per 1,000 calls` : `${who}, hidden from the ${copy}`;
}

/** One sealed offer cell. Plain functions, called in render order, so the carriage timing stays deterministic. */
function offerCell(copy: Copy, side: "buyer" | "seller", offer: SealedSide, seq: ReturnType<typeof sequence>) {
  if (owns(copy, side)) {
    return (
      <td>
        <T text={offer.price} at={seq.text(offer.price)} />
      </td>
    );
  }
  const underAt = seq.text(offer.price);
  return (
    <td>
      <span className="blk">
        <span className="under" aria-hidden="true">
          <T text={offer.price} at={underAt} />
        </span>
        <span className="sr">Price hidden from this side</span>
      </span>
      {copy === "chain" && (
        <span className="cref">
          <span className="sr">Commitment hash </span>
          <LinkOut href={offer.hash.href}>
            <T text={offer.hash.label} at={seq.text(offer.hash.label)} />
          </LinkOut>
        </span>
      )}
    </td>
  );
}

function RoundRow({ round, copy }: { round: OrderRound; copy: Copy }) {
  const seq = sequence();
  const answer = copy === "chain" ? "Answered off-chain" : meetLabel(round.meet);
  const buyer = offerCell(copy, "buyer", round.buyer, seq);
  const answerAt = seq.text(answer);
  const seller = offerCell(copy, "seller", round.seller, seq);
  return (
    <Slot as="tr" id={round.slot}>
      <th scope="row">{round.n}</th>
      {buyer}
      <td className="ref">
        <T text={answer} at={answerAt} />
      </td>
      {seller}
    </Slot>
  );
}

function SettleLine({ order }: { order: OrderView }) {
  const seq = sequence();
  const lineAt = seq.text(order.settle.line);
  seq.gap(STAMP_LEAD_MS);
  const stampAt = seq.gap(DROP_MS);
  const linkAt = seq.text(order.settle.tx.label);
  const whyAt = order.settle.why ? seq.text(order.settle.why) : 0;
  return (
    <Slot id="set" className="settle">
      <span className="lbl">Settlement</span>
      <p className="st-line">
        <T text={order.settle.line} at={lineAt} />
      </p>
      <div className="stamp-zone">
        <Stamp
          lines={["Settled", order.settle.price, "per 1,000 calls"]}
          label={`Settled at ${order.settle.price} per 1,000 calls`}
          at={stampAt}
        />
        <LinkOut href={order.settle.tx.href}>
          <T text={order.settle.tx.label} at={linkAt} />
        </LinkOut>
      </div>
      {order.settle.why && (
        <p className="st-why">
          <T text={order.settle.why} at={whyAt} />
        </p>
      )}
    </Slot>
  );
}

function ReplayButton({ id, describedBy }: { id: string; describedBy: string }) {
  const { replay, skip, running, current, total } = useReplay();
  const label = running ? "Skip to end" : `Replay negotiation #${id}`;
  const sub = running ? `Typing step ${Math.max(1, current)} of ${total}` : `${total} steps, typed onto all three copies`;
  return (
    <button
      className="replay-btn"
      type="button"
      aria-label={running ? `Skip to the end of the replay, now at step ${Math.max(1, current)} of ${total}` : `${label}, ${sub}`}
      aria-describedby={describedBy}
      onClick={running ? skip : replay}
    >
      <span className="box">
        {running ? <FastForward size="1.1em" weight="light" aria-hidden /> : <Play size="1.1em" weight="light" aria-hidden />}
      </span>
      <span aria-hidden="true">
        <span className="bl">{label}</span>
        <span className="bs">{sub}</span>
      </span>
    </button>
  );
}

function Status({ id }: { id: string }) {
  const text = useStatusText();
  const { running, note, total } = useReplay();
  const atRest = !running && !note;
  return (
    <p className="status" id={id}>
      <span className="lbl">Status</span>
      {atRest ? (
        <span>
          All {total} steps on file.<span className="js-only"> Replay types them again.</span>
        </span>
      ) : (
        <span>{text}</span>
      )}
    </p>
  );
}
