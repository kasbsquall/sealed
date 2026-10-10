import { ClipboardText, GithubLogo, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";
import { ExtLink } from "@/components/ExtLink";
import { NoRun } from "@/components/NoRun";
import { SealMark } from "@/components/SealMark";
import { Record } from "@/components/record/Record";
import { OrderLog, type StripField } from "@/components/replay/OrderLog";
import { ReplayProvider } from "@/components/replay/ReplayProvider";
import { TriplicateSet } from "@/components/replay/TriplicateSet";
import { Business, Limits, Mechanism, Verify } from "@/components/sections/Fine";
import { loadDeployment, loadPrivy, loadRuns, loadSeparated, type Deployment, type Run } from "@/lib/data";
import { Mandate } from "@/components/sections/Mandate";
import { addressUrl, short } from "@/lib/format";
import { orderView } from "@/lib/view";

const REPO = "https://github.com/kasbsquall/sealed";
const REPO_NAME = "kasbsquall/sealed";

const NAV = [
  { href: "#replay", label: "Step by step", always: false },
  { href: "#verify", label: "Verify", always: true },
  { href: "#record", label: "Round by round", always: false },
  { href: "#mechanism", label: "How it runs", always: false },
  { href: "#wallets", label: "Privy wallets", always: false },
  { href: "#limits", label: "What it does not claim", always: false },
];

function SectionHead({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <header className="sec-head">
      <h2 id={id}>{title}</h2>
      <p>{children}</p>
    </header>
  );
}

const OUTCOME = { settled: "one deal", expired: "one expiry", aborted: "one aborted" } as const;

function logStrip(runs: Run[], deployment: Deployment): StripField[] {
  const commits = runs.reduce((n, r) => n + r.rounds.length * 2, 0);
  const opened = runs.filter((r) => r.outcome === "settled");
  const contracts = Object.keys(deployment.contracts).length + (deployment.contractsV1 ? 2 : 0);
  return [
    {
      label: "Negotiations shown",
      figure: String(runs.length),
      note: `${runs.length === 1 ? "it ran" : "both ran"} on Monad testnet: ${runs.map((r) => OUTCOME[r.outcome]).join(", ")}`,
    },
    {
      label: "Sealed offers",
      figure: String(commits),
      note: opened.length
        ? `hashes on Monad; only ${opened.map((r) => `#${r.negotiationId}`).join(" and ")}'s ${opened.length * 2} final offers were ever opened`
        : "hashes on Monad; no offer was ever opened",
    },
    {
      label: "Agents",
      figure: `#${deployment.agents.buyer.agentId}, #${deployment.agents.seller.agentId}`,
      note: "each has an ERC-8004 ID and track record on Monad; we wrote these demo records ourselves",
    },
    { label: "Contracts", figure: String(contracts), note: `${deployment.contractsV1 ? "two deployments, " : ""}source verified on Sourcify, exact match` },
  ];
}

/** The hero before any negotiation is on file: the purpose of the order, and no figures. */
function PendingOrder({ deployment }: { deployment: Deployment }) {
  return (
    <section className="hero" id="order" tabIndex={-1} aria-label="Negotiation order">
      <div className="set-wrap">
        <div className="paper paper-w doc">
          <div className="doc-top">
            <p className="doc-title">
              <ClipboardText size="1.1em" weight="light" aria-hidden />
              Negotiation order
            </p>
            <p className="lbl">Monad testnet, chain {deployment.chainId}</p>
          </div>
          <p className="hook">If the seller sees your maximum, it opens just under it</p>
          <h1 className="h1">Your agent can haggle without showing its budget first.</h1>
          <p className="instr">
            Each agent locks a hashed offer on Monad. A relay says only whether the offers cross, and one transaction
            settles at the midpoint.
          </p>
          <NoRun>
            The contracts are deployed
            {deployment.admission.buyer.clears && deployment.admission.seller.clears
              ? ` and agents #${deployment.agents.buyer.agentId} and #${deployment.agents.seller.agentId} clear the gate`
              : ""}
            . The first recorded negotiation will be typed onto this order, with every transaction linked.
          </NoRun>
          <a className="check-link" href="#verify">
            <MagnifyingGlass size="1.1em" weight="light" aria-hidden />
            Verify it on Monad
          </a>
        </div>
      </div>
    </section>
  );
}

export default function Page() {
  const { deal, noDeal } = loadRuns();
  const privy = loadPrivy();
  const runs = [deal, noDeal].filter((r): r is Run => r !== undefined);
  const deployment = loadDeployment();
  // The order on the hero is a settled deal; until one is on file the hero and its log show an empty state.
  const featured = deal?.outcome === "settled" ? deal : undefined;
  const order =
    featured &&
    orderView(featured, {
      buyer: deployment.admission.buyer.clears,
      seller: deployment.admission.seller.clears,
    });
  const ids = runs.map((r) => `#${r.negotiationId}`);
  const nav = NAV.filter((n) => (n.href !== "#replay" || order) && (n.href !== "#wallets" || privy));

  return (
    <>
      <a className="skip" href="#order">
        Skip to the order
      </a>
      <nav className="desk-nav" aria-label="Main">
        <a className="brand" href="#top">
          <SealMark ground="var(--desk)" />
          Sealed
        </a>
        <ul>
          {nav.map((n) => (
            <li key={n.href} className={n.always ? undefined : "opt"}>
              <a className="nl" href={n.href}>
                {n.label}
              </a>
            </li>
          ))}
          <li>
            <a className="nl" href={REPO} target="_blank" rel="noreferrer">
              <GithubLogo size="1.1em" weight="light" aria-hidden />
              <span className="nl-label">Repository</span>
              <span className="sr"> (opens in a new tab)</span>
            </a>
          </li>
        </ul>
      </nav>

      <main id="top">
        {order && featured ? (
          <ReplayProvider steps={order.steps.map(({ n, slot, title }) => ({ n, slot, title }))}>
            <section className="hero" id="order" tabIndex={-1} aria-label={`Negotiation order No. ${order.id}`}>
              <TriplicateSet order={order} />
            </section>

            <section className="sec" id="replay" aria-labelledby="replay-h">
              <SectionHead id="replay-h" title={`Negotiation #${order.id}, step by step`}>
                Every step happened on Monad testnet, and each links to its transaction.
              </SectionHead>
              <OrderLog id={order.id} steps={order.steps} strip={logStrip(runs, deployment)} />
            </section>
          </ReplayProvider>
        ) : (
          <PendingOrder deployment={deployment} />
        )}

        <section className="sec" id="verify" aria-labelledby="verify-h">
          <SectionHead id="verify-h" title="Check it yourself">
            Every link opens Monad testnet on MonadVision or Sourcify
            {runs.length ? ", and the script reads the chain itself" : ""}. You need no wallet.
          </SectionHead>
          <Verify runs={runs} deployment={deployment} />
        </section>

        <section className="sec" id="record" aria-labelledby="record-h">
          <SectionHead
            id="record-h"
            title={`${runs.length === 1 ? "One negotiation" : runs.length ? "Two negotiations" : "Negotiations"}, round by round`}
          >
            {runs.length
              ? `${runs.length === 1 ? "Negotiation" : "Negotiations"} ${ids.join(" and ")}. Switch between what each agent knew and what Monad recorded.`
              : "Each recorded negotiation is filed here, with what each agent knew and what Monad recorded."}
          </SectionHead>
          {runs.length ? (
            <Record runs={runs} />
          ) : (
            <div className="paper paper-w doc">
              <NoRun>Every round will show both offers, the relay&apos;s answer and the commit transaction.</NoRun>
            </div>
          )}
        </section>

        <section className="sec" id="mechanism" aria-labelledby="mech-h">
          <SectionHead id="mech-h" title="How a sealed negotiation runs">
            Two contracts on Monad, and one off-chain relay that sees both offers and tells the agents only yes or no.
          </SectionHead>
          <Mechanism deployment={deployment} />
        </section>

        {privy && (
          <section className="sec" id="wallets" aria-labelledby="wallets-h">
            <SectionHead id="wallets-h" title="What the agents' wallets can do">
              The agents in negotiation #8 and in v2 negotiation #6 signed with Privy server wallets. A Privy policy, not the agent, decides what those wallets may sign.
            </SectionHead>
            <Mandate privy={privy} deployment={deployment} localRun={featured} />
          </section>
        )}

        <section className="sec" id="business" aria-labelledby="biz-h">
          <SectionHead id="biz-h" title="Who pays for Sealed">
            The plan after the event. None of this is charged in the demo.
          </SectionHead>
          <Business deal={featured} />
        </section>

        <section className="sec" id="limits" aria-labelledby="limits-h">
          <SectionHead id="limits-h" title="What this demo does not claim">
            Four limits of this demo.
          </SectionHead>
          <Limits deployment={deployment} separated={loadSeparated()} />
        </section>
      </main>

      <footer className="foot">
        <a className="brand" href="#top">
          <SealMark ground="var(--desk)" />
          Sealed<span className="sr">, back to top</span>
        </a>
        <div className="lks">
          <ExtLink href={REPO}>{REPO_NAME}</ExtLink>
          <ExtLink href={addressUrl(deployment.contracts.SealedNegotiation)}>
            SealedNegotiation {short(deployment.contracts.SealedNegotiation)}
          </ExtLink>
          <ExtLink href={addressUrl(deployment.contracts.ReputationGate)}>
            ReputationGate {short(deployment.contracts.ReputationGate)}
          </ExtLink>
          {deployment.contractsV1 && (
            <ExtLink href={addressUrl(deployment.contractsV1.SealedNegotiation)}>
              first SealedNegotiation {short(deployment.contractsV1.SealedNegotiation)}
            </ExtLink>
          )}
        </div>
        <p>Monad testnet, chain {deployment.chainId}, a test network. Gas is paid in testnet MON.</p>
      </footer>
    </>
  );
}
