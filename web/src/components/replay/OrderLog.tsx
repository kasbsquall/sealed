"use client";

import { ListChecks, Prohibit } from "@phosphor-icons/react";
import type { Step } from "@/lib/view";
import { LinkOut } from "../LinkOut";
import { useReplay } from "./ReplayProvider";
import { TickBox } from "./Typed";

export interface StripField {
  label: string;
  figure: string;
  note: string;
}

/**
 * The order log of the featured negotiation: one ruled table of every step with its
 * transactions, ticked as the replay types that step onto the copies above.
 */
export function OrderLog({ id, steps, strip }: { id: string; steps: Step[]; strip: StripField[] }) {
  const { slots, running, current, total } = useReplay();

  return (
    <div className="paper paper-w doc">
      <div className="doc-top">
        <p className="doc-title">
          <ListChecks size="1.1em" weight="light" aria-hidden />
          Order log, No. {id}
        </p>
        <p className="lbl">
          {running ? `Typing step ${Math.max(1, current)} of ${total}` : `${total} of ${total} steps on file`}
        </p>
      </div>
      <div className="strip log-strip">
        {strip.map((f) => (
          <div className="fld" key={f.label}>
            <span className="lbl">{f.label}</span>
            <span className="big">{f.figure}</span>
            <p>{f.note}</p>
          </div>
        ))}
      </div>
      <table className="log">
        <caption className="sr">Every step of negotiation {id}, with its transactions on Monad testnet</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr">Done</span>
            </th>
            <th scope="col">Step</th>
            <th scope="col">What happened</th>
            <th scope="col">On Monad testnet</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const state = slots[s.slot] ?? "done";
            const cls = [state === "blank" ? "is-blank" : "", running && current === s.n ? "now" : ""].filter(Boolean).join(" ");
            return (
              <tr key={s.n} className={cls || undefined}>
                <td>
                  <TickBox />
                </td>
                <th scope="row">{s.n}</th>
                <td className="what">{s.title}</td>
                <td>
                  <div className="links">
                    {s.links.length ? (
                      s.links.map((l) => (
                        <LinkOut key={l.href} href={l.href}>
                          {l.label}
                        </LinkOut>
                      ))
                    ) : (
                      <span className="notx">
                        <Prohibit size="1.1em" weight="light" aria-hidden />
                        No transaction
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
