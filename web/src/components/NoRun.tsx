import { HourglassMedium } from "@phosphor-icons/react/dist/ssr";

/** The empty state for anything built from a recorded negotiation: no figures until a run is on file. */
export function NoRun({ children }: { children?: React.ReactNode }) {
  return (
    <div className="no-run">
      <p className="no-run-line">
        <HourglassMedium size="1.1em" weight="light" aria-hidden />
        No live run recorded yet on Monad testnet.
      </p>
      {children && <p className="no-run-note">{children}</p>}
    </div>
  );
}
