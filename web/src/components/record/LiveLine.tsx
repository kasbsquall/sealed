"use client";

import { Cube, Warning } from "@phosphor-icons/react";
import { dollars } from "@/lib/format";
import type { Live } from "./useLiveStatus";

/** One eth_call against the contract, so the page does not only repeat the transcript. A skeleton while it loads, never a default value. */
export function LiveLine({ live }: { live: Live | undefined }) {
  const loading = !live || live.state === "loading";
  return (
    <div className="live" role="status" aria-live="polite" aria-busy={loading}>
      {loading ? (
        <>
          <Cube size="1.1em" weight="light" aria-hidden />
          <span>Reading the contract on Monad testnet</span>
          <span className="skeleton" aria-hidden="true" />
        </>
      ) : live.state === "error" ? (
        <>
          <Warning size="1.1em" weight="light" aria-hidden />
          <span>Could not read the contract just now.</span>
        </>
      ) : (
        <>
          <Cube size="1.1em" weight="light" aria-hidden />
          <span>
            Live contract state: status <b>{live.status}</b>, settledPrice <b>{live.price}</b>
            {live.price === "0" ? " (never set)" : ` (US cents, ${dollars(live.price)})`}
          </span>
        </>
      )}
    </div>
  );
}
