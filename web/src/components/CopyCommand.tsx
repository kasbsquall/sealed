"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";

const RESET_MS = 1800;

export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), RESET_MS);
  };

  return (
    <div className="cmd">
      <pre tabIndex={0} role="region" aria-label={label}>
        <code>
          {command.split("\n").map((line) => (
            <span className="cmd-line" key={line}>
              {line}
            </span>
          ))}
        </code>
      </pre>
      <button className="copy" type="button" data-state={state} onClick={copy}>
        {state === "copied" ? <Check size="1.1em" weight="light" aria-hidden /> : <Copy size="1.1em" weight="light" aria-hidden />}
        {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
      </button>
      <span className="sr" role="status">
        {state === "copied" ? "Command copied to the clipboard" : state === "failed" ? "Copy failed, select the text instead" : ""}
      </span>
    </div>
  );
}
