import { Prohibit, Signature, Stamp, Wallet } from "@phosphor-icons/react/dist/ssr";
import type { Deployment, PrivyRecord } from "@/lib/data";
import { addressUrl, dollars, short, txUrl } from "@/lib/format";
import { ExtLink } from "../ExtLink";

/** The probe's response from Privy, shortened to its error code. */
const code = (response: string) => /"code":"([a-z_]+)"/.exec(response)?.[1] ?? "refused";

export function Mandate({ privy, deployment }: { privy: PrivyRecord; deployment: Deployment }) {
  const { run } = privy;
  const refused = privy.mandateProbes.filter((p) => p.refused);
  const signed = privy.mandateProbes.filter((p) => !p.refused);
  const allowed = [
    `Transactions to SealedNegotiation ${short(deployment.contracts.SealedNegotiation)} on Monad testnet, with zero value`,
    "Calls to register on the ERC-8004 Identity Registry, so the agent can create its own identity",
    "Calls to giveFeedback on the ERC-8004 Reputation Registry, so the agent can rate the other party after a deal",
    "EIP-712 signatures whose domain is that same Sealed contract on Monad testnet",
  ];
  return (
    <div className="paper paper-w doc">
      <div className="doc-top">
        <p className="doc-title">
          <Wallet size="1.1em" weight="light" aria-hidden />
          Agent wallets on Privy, policy <span className="mono">{privy.policyId}</span>
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
        </div>
        <div>
          <h3>
            <Prohibit size="1.1em" weight="light" aria-hidden /> Asked of the live wallet, on Monad testnet
          </h3>
          <p className="mandate-count">
            <span className="num">{refused.length}</span> refused, <span className="num">{signed.length}</span> signed
          </p>
          <ul className="mandate-list">
            {refused.map((p) => (
              <li key={p.attempted}>
                {p.label} <span className="mono refused">{code(p.response)}</span>
              </li>
            ))}
            {signed.map((p) => (
              <li key={p.attempted}>
                {p.label} <span className="mono signed">signed</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="mandate-foot">
        {(["buyer", "seller"] as const).map((role) => (
          <span key={role}>
            {role === "buyer" ? "Buyer" : "Seller"} wallet{" "}
            <ExtLink href={addressUrl(privy.wallets[role].address)}>{short(privy.wallets[role].address)}</ExtLink>, ERC-8004 agent{" "}
            <ExtLink href={txUrl(privy.wallets[role].registerTx)}>#{privy.wallets[role].agentId}</ExtLink>.{" "}
          </span>
        ))}
        {run?.settleTx && (
          <span>
            <Stamp size="1em" weight="light" aria-hidden /> Negotiation #{run.negotiationId} ran on these wallets, every
            commitment and authorization signed by Privy, and settled at {dollars(run.settledPrice!)}:{" "}
            <ExtLink href={txUrl(run.settleTx)}>{short(run.settleTx)}</ExtLink>.
          </span>
        )}
      </p>
    </div>
  );
}
