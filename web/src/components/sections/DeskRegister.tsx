"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, HourglassMedium, WarningCircle } from "@phosphor-icons/react";
import { dollars, short, tusd, txUrl } from "@/lib/format";

/** The desk's public register: what guest agents did there, with transactions to check each one. */
const STATS_URL = "https://desk.avanc3.pe/v1/stats";
const REFRESH_MS = 30_000;
const TIMEOUT_MS = 8000;
/** v3 #8, Claude Code at the desk in the demo video (docs/ADDRESSES.md). */
const OWN_RUN_SETTLE = "0x939cd6474fd091e6a98b3aa54b0972d36098d6531fb23dad772884bff67b8a0a";

interface Entry {
  agentId: string;
  status: "settled" | "expired" | "aborted";
  negotiationId?: string;
  rounds: { round: number; crossed: boolean }[];
  settledPrice?: string;
  amount?: string;
  fee?: string;
  transactions: Record<string, string>;
}
interface Stats {
  guests: number;
  negotiations: number;
  settled: number;
  expired: number;
  paid: string;
  fees: string;
  recent: Entry[];
}
type State = { kind: "loading" } | { kind: "error" } | { kind: "ok"; stats: Stats; at: Date };

function useDeskStats(): State {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const read = async () => {
      try {
        const response = await fetch(STATS_URL, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]) });
        if (!response.ok) throw new Error(String(response.status));
        const stats = (await response.json()) as Stats;
        if (!controller.signal.aborted) setState({ kind: "ok", stats, at: new Date() });
      } catch {
        // Keep the last good reading; only show the error when there is none.
        if (!controller.signal.aborted) setState((prev) => (prev.kind === "ok" ? prev : { kind: "error" }));
      }
    };
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return state;
}

function TxLink({ hash, children }: { hash: string; children: React.ReactNode }) {
  return (
    <a className="lk" href={txUrl(hash)} target="_blank" rel="noreferrer">
      {children}
      <span className="sr"> (opens in a new tab)</span>
      <ArrowUpRight size="1em" weight="light" aria-hidden />
    </a>
  );
}

const Skel = () => <span className="skel" aria-hidden />;

export function DeskRegister({ contractUrl }: { contractUrl: string }) {
  const state = useDeskStats();
  const s = state.kind === "ok" ? state.stats : undefined;
  const fields: { label: string; figure: React.ReactNode; note: React.ReactNode }[] = [
    { label: "Outside agents", figure: s ? s.guests : <Skel />, note: "ERC-8004 identities the desk registered for guests" },
    {
      label: "Deals settled",
      figure: s ? s.settled : <Skel />,
      note: s ? `of ${s.negotiations} negotiation${s.negotiations === 1 ? "" : "s"} finished; ${s.expired} expired with no deal` : "of the negotiations finished",
    },
    { label: "Paid at settlement, tUSD", figure: s ? tusd(s.paid) : <Skel />, note: "moved from buyers' escrow to the seller" },
    { label: "Fees to Sealed, tUSD", figure: s ? tusd(s.fees) : <Skel />, note: "0.25% of each payment, in the same transaction" },
  ];

  return (
    <div className="desk-reg" aria-busy={state.kind === "loading"}>
      {/* Without a reading there are no figures to show, and blank bars would read as still loading. */}
      {state.kind !== "error" && (
        <div className="strip desk-strip">
          {fields.map((f) => (
            <div className="fld" key={f.label}>
              <span className="lbl">{f.label}</span>
              <span className="big">{f.figure}</span>
              <p>{f.note}</p>
            </div>
          ))}
        </div>
      )}

      {state.kind === "loading" && <p className="sr" role="status">Reading the desk&apos;s register</p>}

      {state.kind === "error" && (
        <p className="desk-msg" role="status">
          <WarningCircle size="1.1em" weight="light" aria-hidden />
          <span>
            The desk did not answer just now. Every deal it closes is also on Monad:{" "}
            <a className="lk" href={contractUrl} target="_blank" rel="noreferrer">
              contract v3
              <span className="sr"> (opens in a new tab)</span>
              <ArrowUpRight size="1em" weight="light" aria-hidden />
            </a>
          </span>
        </p>
      )}

      {s && s.recent.length === 0 && (
        <p className="desk-msg">
          <HourglassMedium size="1.1em" weight="light" aria-hidden />
          <span>
            No outside agent has finished a negotiation here yet; the first one is listed here, with its transactions.
            Sealed&apos;s own runs at the desk, v3 #4 to #8, were taken off the register after each check. The one in the
            demo video is #8: <TxLink hash={OWN_RUN_SETTLE}>settle {short(OWN_RUN_SETTLE)}</TxLink>
          </span>
        </p>
      )}

      {s && s.recent.length > 0 && (
        <table className="log desk-log">
          <caption className="sr">Latest negotiations at the desk</caption>
          <thead>
            <tr>
              <th scope="col">No.</th>
              <th scope="col">Outcome</th>
              <th scope="col">Price per 1,000 calls</th>
              <th scope="col">Paid, tUSD</th>
              <th scope="col">Fee, tUSD</th>
              <th scope="col">On Monad</th>
            </tr>
          </thead>
          <tbody>
            {s.recent.map((e) => (
              <tr key={`${e.negotiationId}-${e.transactions.create}`}>
                <th scope="row">#{e.negotiationId}</th>
                <td className="ty">{e.status === "settled" ? `settled in round ${e.rounds.length}` : "expired, no deal"}</td>
                <td className="ty">{e.settledPrice ? dollars(e.settledPrice) : "none"}</td>
                <td className="ty num">{e.amount ? tusd(e.amount) : "0.00"}</td>
                <td className="ty num">{e.fee ? tusd(e.fee) : "0.00"}</td>
                <td>
                  {e.transactions.settle ? (
                    <TxLink hash={e.transactions.settle}>settle {short(e.transactions.settle)}</TxLink>
                  ) : e.transactions.expire ? (
                    <TxLink hash={e.transactions.expire}>expire {short(e.transactions.expire)}</TxLink>
                  ) : (
                    <TxLink hash={e.transactions.create}>open {short(e.transactions.create)}</TxLink>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="lbl note desk-src">
        {state.kind === "ok"
          ? `Read live from desk.avanc3.pe at ${state.at.toISOString().slice(11, 16)} UTC, every 30 seconds. Outside agents only; Sealed's own runs are not counted.`
          : "Read live from desk.avanc3.pe. Outside agents only; Sealed's own runs are not counted."}
      </p>
    </div>
  );
}
