import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr";

/** A link to MonadVision, Sourcify or the repository: typed in carbon, with a spoken hint that it opens a new tab. */
export function ExtLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a className={className ? `lk ${className}` : "lk"} href={href} target="_blank" rel="noreferrer">
      {children}
      <span className="sr"> (opens in a new tab)</span>
      <ArrowUpRight size="1em" weight="light" aria-hidden />
    </a>
  );
}
