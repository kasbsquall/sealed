// Unit tests for the built package (dist/), offline. The contract-parity tests
// that deploy SealedNegotiation on a local Hardhat network live at the repo
// root in test/sdk.test.ts; these pin the encoders to values the live Monad
// testnet contract accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AbiCoder, ZeroHash, getAddress } from "ethers";
import * as sdk from "../dist/index.mjs";

const repo = (path) => new URL(`../../../${path}`, import.meta.url);
const run4 = JSON.parse(readFileSync(repo("demo-runs/monadTestnet-deal-4.json"), "utf8"));

test("commitmentHash reproduces every commitment of negotiation #4 on Monad testnet", () => {
  const domain = sdk.sealedDomain();
  assert.equal(domain.verifyingContract, run4.contract);
  let checked = 0;
  for (const round of run4.rounds) {
    for (const role of ["buyer", "seller"]) {
      const side = round[role];
      const commitment = sdk.commitmentHash({
        domain,
        negotiationId: BigInt(run4.negotiationId),
        party: run4.agents[role].wallet,
        commitIndex: side.commitIndex,
        position: { offer: BigInt(side.offer), salt: side.salt },
      });
      assert.equal(commitment, side.commitment, `round ${round.round} ${role}`);
      checked++;
    }
  }
  assert.equal(checked, 6);
});

test("settleAuthorizationDigest equals the live contract's digest for negotiation #4", () => {
  const last = run4.rounds.at(-1);
  const digest = sdk.settleAuthorizationDigest(sdk.sealedDomain(), {
    negotiationId: 4n,
    buyerCommitment: last.buyer.commitment,
    sellerCommitment: last.seller.commitment,
    buyerCommitIndex: last.buyer.commitIndex,
    sellerCommitIndex: last.seller.commitIndex,
  });
  // settleAuthorizationDigest(4) read from 0xAdBd2619... on Monad testnet, 2026-10-09.
  assert.equal(digest, "0xaa10e63973c21e286ae828793b5709fc852bea91beea46969a584415ed892d77");
});

test("salts are 32 random bytes and assertSalt rejects anything else", () => {
  const salts = new Set(Array.from({ length: 200 }, () => sdk.newSalt()));
  assert.equal(salts.size, 200);
  for (const salt of salts) assert.doesNotThrow(() => sdk.assertSalt(salt));
  assert.throws(() => sdk.assertSalt("0x1234"));
});

test("MONAD_TESTNET matches deployments/monadTestnet.json and scripts/registries.ts", () => {
  const deployment = JSON.parse(readFileSync(repo("deployments/monadTestnet.json"), "utf8"));
  const registries = readFileSync(repo("scripts/registries.ts"), "utf8");
  const t = sdk.MONAD_TESTNET;
  assert.equal(t.chainId, deployment.chainId);
  assert.equal(t.sealedNegotiation, deployment.contracts.SealedNegotiation);
  assert.equal(t.reputationGate, deployment.contracts.ReputationGate);
  assert.equal(t.identityRegistry, deployment.registries.identity);
  assert.equal(t.reputationRegistry, deployment.registries.reputation);
  assert.ok(registries.includes(t.identityRegistry) && registries.includes(t.reputationRegistry));
  assert.deepEqual([...t.demoPolicy.reviewers], deployment.policy.reviewers);
  assert.equal(t.demoPolicy.minFeedbackCount, BigInt(deployment.policy.minFeedbackCount));
  assert.equal(t.demoPolicy.minAverageValue, BigInt(deployment.policy.minAverageValue));
  assert.equal(t.demoPolicy.decimals, deployment.policy.decimals);
});

const V1 = ["address", "address", "uint256", "uint256", "bytes32", "bytes32", "uint32", "uint32", "uint64", "uint8", "uint256", "bytes32"];
const fields = ["0x22363d16A46cdAa6FC2733d222AE53613b984f1c", "0x7351f1784e8F63B005E997600a3a0E65020987CC", 2084n, 2085n, ZeroHash, ZeroHash, 3n, 2n, 1791535855n, 3n, 4190n, ZeroHash];

test("decodeNegotiation reads the current layout and keeps appended fields", () => {
  const coder = AbiCoder.defaultAbiCoder();
  const v1 = sdk.decodeNegotiation(4n, coder.encode(V1, fields));
  assert.equal(v1.status, "Settled");
  assert.equal(v1.buyerWallet, getAddress(fields[0]));
  assert.equal(v1.buyerCommitIndex, 3);
  assert.equal(v1.sellerCommitIndex, 2);
  assert.equal(v1.settledPrice, 4190n);
  assert.deepEqual(v1.extra, []);

  // A later version that appends a bytes32 (a static struct grows by one word).
  const policyHash = "0x" + "ab".repeat(32);
  const v2 = sdk.decodeNegotiation(4n, coder.encode([`(${V1.join(",")},bytes32)`], [[...fields, policyHash]]));
  assert.equal(v2.settledPrice, 4190n);
  assert.deepEqual(v2.extra, [policyHash]);

  // A version that appends a dynamic field comes back behind an offset word.
  const v3 = sdk.decodeNegotiation(4n, coder.encode([`(${V1.join(",")},string)`], [[...fields, "x"]]));
  assert.equal(v3.status, "Settled");
  assert.equal(v3.deadline, 1791535855n);
});

test("the CommonJS build exposes the same API", () => {
  const cjs = createRequire(import.meta.url)("../dist/index.js");
  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(sdk).sort());
  assert.equal(cjs.domainSeparator(cjs.sealedDomain()), sdk.domainSeparator(sdk.sealedDomain()));
});
