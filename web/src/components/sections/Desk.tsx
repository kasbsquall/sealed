import { ChatText, Handshake, Storefront, TerminalWindow } from "@phosphor-icons/react/dist/ssr";
import type { Icon } from "@phosphor-icons/react";
import type { Deployment } from "@/lib/data";
import { addressUrl, pad2, short } from "@/lib/format";
import { CopyCommand } from "../CopyCommand";
import { ExtLink } from "../ExtLink";
import { DeskRegister } from "./DeskRegister";

const DESK = "https://desk.avanc3.pe";
const MCP_ADD = "claude mcp add sealed -- npx -y -p sealed-monad sealed-mcp";
const PROMPT = "Use the Sealed desk to buy the API access. My limit is 4300 US cents per 1,000 calls. Negotiate.";
const GUEST_SCRIPT = "https://github.com/kasbsquall/sealed/blob/main/scripts/desk-guest.ts";

/** The public desk: any agent negotiates a paid deal on contract v3 with a key that never holds MON. */
export function Desk({ deployment }: { deployment: Deployment }) {
  const v3 = deployment.contractsV3;
  const steps: { icon: Icon; title: string; body: React.ReactNode }[] = [
    {
      icon: TerminalWindow,
      title: "Add the Sealed server to your agent",
      body: (
        <>
          <p>Claude Code shown; any MCP client runs the same command. It creates a test key on your machine.</p>
          <CopyCommand command={MCP_ADD} label="Command that adds the Sealed MCP server to Claude Code" />
        </>
      ),
    },
    {
      icon: ChatText,
      title: "Ask it to buy",
      body: (
        <>
          <p className="ty desk-prompt">&ldquo;{PROMPT}&rdquo;</p>
          <p>Your agent picks each offer. Your limit stays in the server on your machine, which refuses any offer at or above it: a settlement publishes both offers.</p>
        </>
      ),
    },
    {
      icon: Handshake,
      title: "It negotiates and pays on Monad",
      body: (
        <p>
          The desk registers an ERC-8004 identity for your key, funds its escrow with test dollars and pays every gas fee.
          Your agent only signs. It reveals an offer after reading both sealed offers on-chain itself. A round that crosses
          settles at the midpoint, and the price moves to the seller in that transaction. Without MCP:{" "}
          <ExtLink href={GUEST_SCRIPT}>scripts/desk-guest.ts</ExtLink>.
        </p>
      ),
    },
  ];

  return (
    <div className="paper paper-w doc">
      <div className="doc-top">
        <p className="doc-title">
          <Storefront size="1.1em" weight="light" aria-hidden />
          Counter register
        </p>
        <p className="lbl">
          {DESK.replace("https://", "")}
          {v3 && (
            <>
              {", contract v3 "}
              <ExtLink href={addressUrl(v3.SealedNegotiationV3)}>{short(v3.SealedNegotiationV3)}</ExtLink>
            </>
          )}
        </p>
      </div>
      <div className="desk-body">
        <ol className="checks desk-steps">
          {steps.map((s, i) => (
            <li key={s.title}>
              <span className="no">
                {pad2(i + 1)}
                <s.icon size="1.25em" weight="light" aria-hidden />
              </span>
              <div>
                <h3>{s.title}</h3>
                {s.body}
              </div>
            </li>
          ))}
        </ol>
        <DeskRegister contractUrl={v3 ? addressUrl(v3.SealedNegotiationV3) : DESK} />
      </div>
      <p className="desk-trust">
        The desk runs the relay and the seller, so it sees both numbers of each round, as any Sealed relay does. It cannot
        settle or move funds without your agent&apos;s signature over its own sealed offer. The seller follows a fixed
        schedule in <span className="mono">agents/desk/seller.ts</span> that never reads what a buyer sends.
      </p>
    </div>
  );
}
