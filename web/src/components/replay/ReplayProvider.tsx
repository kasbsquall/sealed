"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Replay of the featured negotiation order. The server renders the final state, so
 * the page reads correctly without JavaScript and with reduced motion. Replay
 * blanks every slot, then retypes them step by step on all three copies and
 * ticks the order log in sync. While it runs, the same button skips to the end.
 */

export type SlotState = "blank" | "typing" | "done";

export interface ReplayStepInfo {
  n: number;
  slot: string;
  title: string;
}

interface ReplayContextValue {
  slots: Record<string, SlotState>;
  running: boolean;
  /** Step being typed, 0 before the first one; equals total when idle. */
  current: number;
  total: number;
  steps: ReplayStepInfo[];
  /** Shown in the status line after Replay is pressed with reduced motion. */
  note: string;
  replay: () => void;
  skip: () => void;
}

const ReplayContext = createContext<ReplayContextValue | null>(null);

/** Pause before the first step, after each step, and the longer hold after the stamp lands. */
const LEAD_MS = 260;
const STEP_GAP_MS = 420;
const STAMP_HOLD_MS = 900;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** The latest moment any typed line or stamp in this slot finishes, read from the rendered copies. */
const slotEnd = (slot: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-slot="${slot}"] [data-end]`)).reduce(
    (max, el) => Math.max(max, Number(el.dataset.end) || 0),
    0,
  );

export function ReplayProvider({ steps, children }: { steps: ReplayStepInfo[]; children: React.ReactNode }) {
  const total = steps.length;
  const [slots, setSlots] = useState<Record<string, SlotState>>({});
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState(total);
  const [note, setNote] = useState("");
  const [announcement, setAnnouncement] = useState("");
  /** Each run gets a number; a skip or unmount bumps it, and the stale loop stops at its next await. */
  const generation = useRef(0);

  useEffect(() => {
    const gen = generation;
    return () => {
      gen.current += 1;
    };
  }, []);

  const finalMessage = `All ${total} steps on file.`;

  const finish = useCallback(
    (message: string) => {
      generation.current += 1;
      setSlots({});
      setCurrent(total);
      setRunning(false);
      setAnnouncement(message);
    },
    [total],
  );

  const skip = useCallback(() => finish(`Skipped to the end. ${finalMessage}`), [finish, finalMessage]);

  const replay = useCallback(async () => {
    if (running) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const message = `Shown in its final state, without motion. ${finalMessage}`;
      setNote(message);
      finish(message);
      return;
    }
    const gen = ++generation.current;
    setNote("");
    setRunning(true);
    setCurrent(0);
    setSlots(Object.fromEntries(steps.map((s) => [s.slot, "blank" as const])));
    setAnnouncement(`Replaying negotiation order, ${total} steps.`);
    await wait(LEAD_MS);

    for (const step of steps) {
      if (gen !== generation.current) return;
      setCurrent(step.n);
      setSlots((prev) => ({ ...prev, [step.slot]: "typing" }));
      await nextFrame();
      const end = slotEnd(step.slot);
      const hasStamp = document.querySelector(`[data-slot="${step.slot}"] .stamp`) !== null;
      await wait(end + (hasStamp ? STAMP_HOLD_MS : STEP_GAP_MS));
      if (gen !== generation.current) return;
      setSlots((prev) => ({ ...prev, [step.slot]: "done" }));
    }
    finish(`Replay finished. ${finalMessage}`);
  }, [running, steps, total, finish, finalMessage]);

  return (
    <ReplayContext.Provider value={{ slots, running, current, total, steps, note, replay, skip }}>
      {children}
      <p className="sr" role="status" aria-live="polite">
        {announcement}
      </p>
    </ReplayContext.Provider>
  );
}

export function useReplay() {
  const ctx = useContext(ReplayContext);
  if (!ctx) throw new Error("useReplay must be used inside ReplayProvider");
  return ctx;
}

/** The status line text, the same on every copy. At rest it says the record is complete, never an error. */
export function useStatusText() {
  const { current, total, steps, running, note } = useReplay();
  if (!running) return note || `All ${total} steps on file. Replay types them again.`;
  if (current === 0) return "Starting the replay";
  return `Step ${current} of ${total}: ${steps[current - 1].title}`;
}
