// The party server from dist/, driven by HttpParty as the relay would drive
// it, with a scripted agent of one's own instead of a NegotiatorAgent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { HttpParty, commitmentHash, newSalt, sealedDomain, serveParty, serverUrl, settleAuthorizationTypedData } from "../dist/index.mjs";

const TOKEN = "t".repeat(40);

function scriptedAgent() {
  const wallet = Wallet.createRandom();
  const domain = sealedDomain();
  let current;
  return {
    wallet,
    async decide(round) {
      return { round, stance: "hold", offer: 4200n, explanation: "scripted", steps: [] };
    },
    async commit(negotiationId, commitIndex) {
      current = { commitIndex, position: { offer: 4200n, salt: newSalt() } };
      const commitment = commitmentHash({ domain, negotiationId, party: wallet.address, commitIndex, position: current.position });
      return { txHash: "0x" + "00".repeat(32), commitment };
    },
    // Async on purpose: an agent of your own may fetch its reveal from storage.
    async reveal() {
      return { party: wallet.address, commitIndex: current.commitIndex, position: current.position };
    },
    async authorize(message) {
      const typed = settleAuthorizationTypedData(domain, message);
      return wallet.signTypedData(typed.domain, { SettleAuthorization: [...typed.types.SettleAuthorization] }, typed.message);
    },
  };
}

test("an agent of one's own joins through the five routes", async () => {
  const agent = scriptedAgent();
  const server = await serveParty(agent, TOKEN);
  try {
    const url = serverUrl(server);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const party = await HttpParty.connect(url, TOKEN);
    assert.equal(party.wallet.address, agent.wallet.address);

    const decision = await party.decide(1, 9n);
    assert.equal(decision.offer, 4200n);

    const { commitment } = await party.commit(9n, 1);
    const reveal = await party.reveal();
    assert.equal(reveal.position.offer, 4200n);
    assert.equal(
      commitmentHash({ domain: sealedDomain(), negotiationId: 9n, party: reveal.party, commitIndex: reveal.commitIndex, position: reveal.position }),
      commitment,
    );
    await assert.rejects(party.reveal(), /already revealed/);

    const signature = await party.authorize({ negotiationId: 9n, buyerCommitment: commitment, sellerCommitment: commitment, buyerCommitIndex: 1, sellerCommitIndex: 1 });
    assert.match(signature, /^0x[0-9a-f]{130}$/);

    await assert.rejects(party.rateCounterparty("0x" + "11".repeat(32)), /does not rate/);
  } finally {
    server.close();
  }
});

test("every route answers 401 without the token, and short tokens are refused", async () => {
  assert.throws(() => serveParty(scriptedAgent(), "short"), /at least 32/);
  const server = await serveParty(scriptedAgent(), TOKEN);
  try {
    for (const route of ["identity", "decide", "commit", "reveal", "authorize", "rate"]) {
      const response = await fetch(`${serverUrl(server)}/${route}`, { method: "POST", headers: { authorization: "Bearer wrong" } });
      assert.equal(response.status, 401, route);
    }
  } finally {
    server.close();
  }
});
