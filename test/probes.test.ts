import { expect } from "chai";
import { probesHold, runMandateProbes } from "../agents/privy/probes";

const probe = (attempted: string, expect: "refused" | "allowed", run: () => Promise<unknown>) => ({ id: attempted, attempted, label: attempted, expect, run });
const refusal = () => Promise.reject(new Error('403 {"code":"policy_violation"}'));

describe("Privy mandate probes", () => {
  it("counts only Privy's policy refusal as refused, and reports any other error as inconclusive", async () => {
    const probes = [
      probe("transfer", "refused", refusal),
      probe("network down", "refused", () => Promise.reject(new Error("ECONNRESET"))),
      probe("sealed call", "allowed", async () => "signed"),
    ];
    const { records, inconclusive } = await runMandateProbes(probes, [], () => {});
    expect(records.map((r) => [r.attempted, r.refused])).to.deep.equal([["transfer", true], ["sealed call", false]]);
    expect(inconclusive.map((i) => i.attempted)).to.deep.equal(["network down"]);
    // An inconclusive probe means the mandate was not shown to hold.
    expect(probesHold(probes, records, inconclusive)).to.equal(false);
    expect(probesHold(probes.slice(0, 1), records.slice(0, 1), [])).to.equal(true);
  });

  it("does not hold on an empty run", () => {
    expect(probesHold([{ id: "transfer" }], [], [])).to.equal(false);
  });

  it("never stores what Privy returns when it signs a probe it should have refused", async () => {
    const { records } = await runMandateProbes(
      [probe("transfer", "refused", async () => ({ signed_transaction: "0x02f8deadbeef" }))],
      [],
      () => {},
    );
    expect(records[0].refused).to.equal(false);
    expect(records[0].response).to.not.include("0x02f8");
  });

  it("keeps earlier records it was not asked to run, on every save", async () => {
    const saves: string[][] = [];
    await runMandateProbes(
      [probe("new", "refused", refusal)],
      [{ id: "old", attempted: "old", refused: true, response: "policy_violation" }],
      (r) => saves.push(r.map((x) => x.id)),
    );
    for (const saved of saves) expect(saved).to.include.members(["new", "old"]);
  });

  it("does not send a recorded probe again", async () => {
    let sent = 0;
    const { records } = await runMandateProbes(
      [probe("transfer", "refused", () => (sent++, refusal()))],
      [{ attempted: "transfer", refused: true, response: "policy_violation" }],
      () => {},
    );
    expect(sent).to.equal(0);
    expect(records[0]).to.include({ label: "transfer", expect: "refused", refused: true });
  });

  it("fails when Privy signs something the mandate should refuse", () => {
    expect(probesHold([{ id: "a" }], [{ id: "a", attempted: "a", label: "a", expect: "refused", refused: false, response: "" }], [])).to.equal(false);
  });
});
