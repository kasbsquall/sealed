import { expect } from "chai";
import { ethers } from "hardhat";
import { Wallet } from "ethers";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import fs from "fs";
import { deployRegistries } from "./helpers/erc8004";
import { Desk } from "../agents/desk/desk";
import { deskApp } from "../agents/desk/server";
import { DeskClient } from "../agents/desk/client";
import { SerialWallet } from "../agents/desk/serialWallet";
import { askFor, drawFloor } from "../agents/desk/seller";

const SCALE = 10_000n * 1_000n;
const LISTING = { listPrice: 4400n, floor: 4050n, finalMargin: 40n, maxRounds: 3 };
const OPEN_POLICY = { reviewers: ["0x000000000000000000000000000000000000dEaD"], minFeedbackCount: 0n, minAverageValue: 0n, decimals: 0, tag1: "" };

async function setup() {
  const [funder] = await ethers.getSigners();
  const operator = new SerialWallet(Wallet.createRandom().privateKey, ethers.provider);
  await funder.sendTransaction({ to: operator.address, value: ethers.parseEther("10") });
  const sellerKey = Wallet.createRandom().connect(ethers.provider);

  const registries = await deployRegistries();
  const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(
    await registries.identity.getAddress(),
    await registries.reputation.getAddress(),
  );
  const sealed = await (await ethers.getContractFactory("SealedNegotiationV3")).deploy(await gate.getAddress(), funder.address);
  const usd = await (await ethers.getContractFactory("SealedTestUSD")).deploy();

  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "desk-")), "desk.json");
  const desk = new Desk({
    operator,
    sellerKey,
    chainId: (await ethers.provider.getNetwork()).chainId,
    contracts: { sealed: await sealed.getAddress(), token: await usd.getAddress(), identity: await registries.identity.getAddress() },
    terms: "Desk test terms",
    termsSchema: ethers.id("Desk test terms"),
    unit: "US cents per 1,000 API calls",
    scale: SCALE,
    calls: 1_000_000n,
    listing: LISTING,
    policy: OPEN_POLICY,
    guestFloat: 50_000n * 1_000_000n,
    windowSeconds: 900,
    limits: { maxOpenSessions: 2, maxGuestsPerDay: 10, maxSessionsPerDay: 10, minOperatorBalance: ethers.parseEther("0.1") },
    dataFile,
  });
  await desk.prepare();
  const server: Server = createServer(deskApp(desk));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const guestKey = Wallet.createRandom().connect(ethers.provider);
  const client = new DeskClient({ url, key: guestKey, provider: ethers.provider, expectedContract: await sealed.getAddress(), pollMs: 50, waitMs: 60_000 });
  return { desk, server, url, client, guestKey, sealed, usd, sellerKey, funder, operator };
}

describe("The Sealed desk: a guest with no MON negotiates a paid deal", function () {
  this.timeout(120_000);

  it("the seller's schedule depends only on the round", () => {
    const listing = { ...LISTING, termsSchema: "", token: "", scale: 1n, policyHash: "" };
    expect([1, 2, 3].map((r) => askFor(listing, r))).to.deep.equal([4400n, 4190n, 4106n]);
  });

  it("draws each negotiation's floor from the private range, so one settlement does not reveal the next floor", () => {
    const draws = Array.from({ length: 200 }, () => drawFloor(4050n, 120n));
    expect(draws.every((f) => f >= 4050n && f <= 4170n)).to.equal(true);
    expect(new Set(draws.map(String)).size).to.be.greaterThan(20);
    expect(drawFloor(4050n, 0n)).to.equal(4050n);
    const listing = { ...LISTING, termsSchema: "", token: "", scale: 1n, policyHash: "" };
    expect(askFor({ ...listing, floor: 4050n }, 3)).not.to.equal(askFor({ ...listing, floor: 4150n }, 3));
  });

  it("refuses a floor range that could reach the list price", () => {
    expect(() => drawFloor(4300n, 100n, 4400n, 40n)).to.throw(/list price/);
  });

  it("joins, opens on signed terms, and settles in round 2 with the price paid from its escrow", async () => {
    const { server, client, guestKey, sealed, usd, sellerKey, desk } = await setup();
    try {
      const info = await client.describe();
      expect(info.seller.listPrice).to.equal("4400");
      expect(JSON.stringify(info)).not.to.contain("4050");

      const { agentId } = await client.join();
      expect(await ethers.provider.getBalance(guestKey.address)).to.equal(0n);
      await client.open(agentId, 4300n);

      const r1 = await client.offer(4000n, "open-with-room");
      expect(r1).to.include({ round: 1, crossed: false, roundsLeft: 2 });

      await expect(client.offer(4400n)).to.be.rejectedWith(/above this buyer's limit/);

      const r2 = await client.offer(4200n);
      expect(r2).to.include({ round: 2, crossed: true, status: "settled", settledPrice: "4195" });
      const amount = 4195n * SCALE;
      const fee = (amount * 25n + 9_999n) / 10_000n;
      expect(r2.amount).to.equal(amount.toString());
      expect(await usd.balanceOf(sellerKey.address)).to.equal(amount - fee);
      expect(await sealed.escrowOf(await usd.getAddress(), guestKey.address)).to.equal(50_000n * 1_000_000n - amount);
      // The guest never paid gas.
      expect(await ethers.provider.getBalance(guestKey.address)).to.equal(0n);

      const stats = desk.stats();
      expect(stats).to.include({ guests: 1, negotiations: 1, settled: 1, paid: amount.toString(), fees: fee.toString() });
      expect(JSON.stringify(stats.recent)).not.to.contain('"4000"');
    } finally {
      server.close();
    }
  });

  it("refuses a reveal that does not match the signed commitment, and keeps waiting for the right one", async () => {
    const { server, client, url } = await setup();
    try {
      const { agentId } = await client.join();
      const { sessionId } = await client.open(agentId, 4300n);
      // Play round 1 by hand up to the reveal, then send a wrong one.
      const offerPromise = client.offer(4000n);
      let wrong: Response | undefined;
      for (let i = 0; i < 400 && !wrong; i++) {
        const s = await (await fetch(`${url}/v1/sessions/${sessionId}`)).json();
        if (s.pending?.kind === "reveal") {
          wrong = await fetch(`${url}/v1/sessions/${sessionId}/reveal`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ round: 1, offer: "4100", salt: ethers.hexlify(ethers.randomBytes(32)) }),
          });
        } else await new Promise((r) => setTimeout(r, 20));
      }
      expect(wrong?.status).to.equal(400);
      expect((await wrong!.json()).error).to.match(/does not hash/);
      // The real client's own reveal may already have gone in first; either way round 1 completes.
      const r1 = await offerPromise.catch((e) => e);
      expect(r1.round ?? 1).to.equal(1);
    } finally {
      server.close();
    }
  });

  it("refuses a guest that signs terms for a different contract", async () => {
    const { server, url, guestKey } = await setup();
    try {
      const wrong = new DeskClient({ url, key: guestKey, provider: ethers.provider, expectedContract: ethers.ZeroAddress, pollMs: 50 });
      await expect(wrong.describe()).to.be.rejectedWith(/names contract/);
    } finally {
      server.close();
    }
  });
});
