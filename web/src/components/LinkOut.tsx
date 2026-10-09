"use client";

import { ArrowUpRight } from "@phosphor-icons/react";

/** ExtLink for client components: the same link, with the icon from the client entry of Phosphor. */
export function LinkOut({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="lk" href={href} target="_blank" rel="noreferrer">
      {children}
      <span className="sr"> (opens in a new tab)</span>
      <ArrowUpRight size="1em" weight="light" aria-hidden />
    </a>
  );
}
