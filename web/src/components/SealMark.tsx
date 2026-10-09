/**
 * The Cruce isotipo: the buyer's line rises, the seller's falls, and the orange
 * square is where they settle. The cut-out around the square takes the colour
 * of whatever it is printed on.
 */
export function SealMark({ ground, className }: { ground: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <line x1="8" y1="52" x2="56" y2="20" stroke="currentColor" strokeWidth="6.5" strokeLinecap="square" />
      <line x1="8" y1="16" x2="56" y2="44" stroke="currentColor" strokeWidth="6.5" strokeLinecap="square" />
      <rect x="31.3" y="27.3" width="11" height="11" fill={ground} />
      <rect x="32.8" y="28.8" width="8" height="8" fill="var(--deal)" />
    </svg>
  );
}
