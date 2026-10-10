import { Prohibit, SealCheck, Signature, Stamp, UsersThree, Wallet } from "@phosphor-icons/react/dist/ssr";
import type { Icon } from "@phosphor-icons/react";
import type { Deployment, PrivyRecord, Run } from "@/lib/data";
import { addressUrl, dollars, short, txUrl } from "@/lib/format";
import { ExtLink } from "../ExtLink";

type Probe = PrivyRecord["mandateProbes"][number];

/** The probe's response from Privy, shortened to its HTTP status and error code when it has one, e.g. "400 policy_violation". */
const code = (response: string) =>
  [/^(\d{3})/.exec(response)?.[1], /"code":"([a-z_]+)"/.exec(response)?.[1]].filter(Boolean).join(" ") || "refused";

/** "2 of 2" as "2-of-2". */
const threshold = (ownership: PrivyRecord["ownership"]) => ownership?.adminThreshold.replace(/ /g, "-");

/** One verdict as a plain heading, its probes under it, each with Privy's response code as the technical tag. */
function ProbeGroup({
  icon: GroupIcon,
  title,
  probes,
  withCode = false,
}: {
  icon: Icon;
  title: string;
  probes: Probe[];
  withCode?: boolean;
}) {
  if (!probes.length) return null;
  return (
    <>
      <h4 className="probe-group">
        <GroupIcon size="1.1em" weight="light" aria-hidden />
        {title} <span className="num">{probes.length}</span>
      </h4>
      <ul className="mandate-list">
        {probes.map((p) => (
          <li key={p.attempted}>
            {p.label}
            {withCode && <span className="mono code">{code(p.response)}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

export function Mandate({ privy, deployment, localRun }: { privy: PrivyRecord; deployment: Deployment; localRun?: Run }) {
  const { run, ownership } = privy;
  const refused = privy.mandateProbes.filter((p) => p.refused);
  const byPolicy = refused.filter((p) => p.refusedBy !== "owner");
  const byOwner = refused.filter((p) => p.refusedBy === "owner");
  const signed = privy.mandateProbes.filter((p) => !p.refused);
  // The mandate was written for the first deployment and later extended to the current one.
  const mandateContracts = privy.mandateContracts ?? [deployment.contractsV1?.SealedNegotiation ?? deployment.contracts.SealedNegotiation];
  const isCurrent = (r: Run) => Boolean(deployment.contractsV1) && r.contract === deployment.contracts.SealedNegotiation;
  const label = (r: Run) => `${isCurrent(r) ? "v2 negotiation" : "Negotiation"} #${r.negotiationId}`;
  const allowed = [
    `Transactions to SealedNegotiation ${mandateContracts.map((a) => short(a)).join(" or ")} on Monad testnet, with zero value`,
    "Calls to register on the ERC-8004 Identity Registry, so the agent can create its own identity",
    "Calls to giveFeedback on the ERC-8004 Reputation Registry, so the agent can rate the other party after a deal",
    "EIP-712 signatures whose domain is one of those Sealed contracts on Monad testnet",
  ];
  const ids = (r: Run) => `#${r.agents.buyer.agentId} and #${r.agents.seller.agentId}`;
  const showBridge = localRun && run && localRun.negotiationId !== run.negotiationId;
  return (
    <div className="paper paper-w doc">
      <div className="doc-top">
        <p className="doc-title">
          <Wallet size="1.1em" weight="light" aria-hidden />
          Agent wallets on Privy, policy <span className="mono" title={privy.policyId}>{privy.policyId.slice(0, 8)}…</span>
        </p>
      </div>
      <div className="mandate">
        <div>
          <h3>
            <Signature size="1.1em" weight="light" aria-hidden /> The policy allows only
          </h3>
          <ul className="mandate-list">
            {allowed.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          {ownership && (
            <p className="mandate-note">
              The policy and both wallets belong to a {threshold(ownership)} admin key quorum whose keys no agent or relay
              code loads. The agent&apos;s own key is only an extra signer held to the policy: it can sign negotiations, and
              it cannot edit its mandate, take back its wallet or export its key.
            </p>
          )}
        </div>
        <div>
          <h3>
            <Prohibit size="1.1em" weight="light" aria-hidden /> Asked of the live wallet, on Monad testnet
          </h3>
          <p className="mandate-count">
            <span className="num">{refused.length}</span> refused, <span className="num">{signed.length}</span> signed
          </p>
          <p className="mandate-gist">
            Privy blocked the {refused.length} requests a hijacked agent would try and signed the {signed.length} a
            negotiator needs.
          </p>
          {/* Records without refusedBy predate the owner probes, and every one of them is a policy refusal. */}
          <ProbeGroup icon={Prohibit} title="Blocked by the mandate" probes={byPolicy} withCode />
          <ProbeGroup
            icon={UsersThree}
            title={ownership ? `Blocked: needs the ${threshold(ownership)} admin quorum` : "Blocked: needs the admin quorum"}
            probes={byOwner}
            withCode
          />
          <ProbeGroup icon={SealCheck} title="Signed" probes={signed} />
        </div>
      </div>
      <p className="mandate-foot">
        {showBridge && (
          <span>
            Negotiation #{localRun.negotiationId} ran agents {ids(localRun)} with local keys. {label(run)} ran the same flow with agents {ids(run)} on these Privy wallets, so the agent numbers
            differ.{" "}
          </span>
        )}
        {(["buyer", "seller"] as const).map((role) => (
          <span key={role}>
            {role === "buyer" ? "Buyer" : "Seller"} wallet{" "}
            <ExtLink href={addressUrl(privy.wallets[role].address)}>{short(privy.wallets[role].address)}</ExtLink>, ERC-8004 agent{" "}
            <ExtLink href={txUrl(privy.wallets[role].registerTx)}>#{privy.wallets[role].agentId}</ExtLink>.{" "}
          </span>
        ))}
        {run?.settleTx && (
          <span>
            <Stamp size="1em" weight="light" aria-hidden /> {label(run)} ran on these wallets, every
            commitment and authorization signed by Privy, and settled at {dollars(run.settledPrice!)}:{" "}
            <ExtLink href={txUrl(run.settleTx)}>{short(run.settleTx)}</ExtLink>.
          </span>
        )}
      </p>
    </div>
  );
}
