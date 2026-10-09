"use client";

import { createContext, createElement, useContext } from "react";
import { useReplay, type SlotState } from "./ReplayProvider";

/** One keystroke of carbon: each character fades in over KEY_MS, CHAR_MS after the previous one. */
export const CHAR_MS = 18;
const KEY_MS = 90;
/** The stamp lands in 230 ms: from scale 1.08 and 2 degrees off to its resting angle. */
export const DROP_MS = 230;

const SlotContext = createContext<SlotState>("done");

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

type SlotProps = React.HTMLAttributes<HTMLElement> & { id: string; as?: "div" | "tr" | "span" };

/** A field group that the replay blanks and retypes as one step. The id is shared by every copy. */
export function Slot({ id, as = "div", className, children, ...rest }: SlotProps) {
  const { slots } = useReplay();
  const state = slots[id] ?? "done";
  return createElement(
    as,
    {
      ...rest,
      "data-slot": id,
      className: cx(className, state === "blank" && "is-blank", state === "typing" && "is-typing") || undefined,
    },
    <SlotContext.Provider value={state}>{children}</SlotContext.Provider>,
  );
}

/** Start times for the lines of one slot, in render order, so a slot types like one pass of the carriage. */
export function sequence(start = 0) {
  let t = start;
  return {
    text(s: string) {
      const at = t;
      t += s.length * CHAR_MS;
      return at;
    },
    gap(ms: number) {
      const at = t;
      t += ms;
      return at;
    },
  };
}

/** Text typed onto the form. Plain text except while its slot is being typed. */
export function T({ text, at, className }: { text: string; at: number; className?: string }) {
  const state = useContext(SlotContext);
  if (state !== "typing") return <span className={cx("t", className)}>{text}</span>;
  return (
    <span className={cx("t", className)} data-end={at + text.length * CHAR_MS + KEY_MS}>
      <span className="sr">{text}</span>
      <span className="typing" aria-hidden="true">
        {Array.from(text).map((ch, i) => (
          <span key={i} style={{ animationDelay: `${at + i * CHAR_MS}ms` }}>
            {ch}
          </span>
        ))}
      </span>
    </span>
  );
}

/** The rubber stamp. Orange only for a settlement; an expiry is stamped in carbon. */
export function Stamp({
  lines,
  label,
  tone = "deal",
  at = 0,
}: {
  lines: [string, string?, string?];
  label: string;
  tone?: "deal" | "carbon";
  at?: number;
}) {
  const state = useContext(SlotContext);
  const dropping = state === "typing";
  const [top, figure, unit] = lines;
  return (
    <div
      className={cx("stamp", tone === "carbon" && "carbon", dropping && "drop")}
      style={dropping ? { animationDelay: `${at}ms` } : undefined}
      data-end={dropping ? at + DROP_MS : undefined}
      role="img"
      aria-label={label}
    >
      <span className="s1">{top}</span>
      {figure && <span className="s2">{figure}</span>}
      {unit && <span className="s3">{unit}</span>}
    </div>
  );
}

/** A pre-printed tick box; the carbon cross is drawn when its slot is typed. */
export function TickBox() {
  return (
    <span className="cbox">
      <svg className="ck" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 4L16 16M16 4L4 16" pathLength={1} />
      </svg>
    </span>
  );
}
