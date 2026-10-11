// Submits the deployed contracts to Sourcify (API v2, no key needed), using the
// exact compiler input from Hardhat's build-info. Run after `npx hardhat compile`.
//   node scripts/verify-sourcify.cjs
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const dir = path.join(root, "artifacts/build-info");
const deployment = JSON.parse(fs.readFileSync(path.join(root, "deployments/monadTestnet.json"), "utf8"));
const targets = [
  [deployment.contracts.ReputationGate, "contracts/ReputationGate.sol:ReputationGate"],
  [deployment.contracts.SealedNegotiation, "contracts/SealedNegotiation.sol:SealedNegotiation"],
  ...(deployment.contractsV3
    ? [
        [deployment.contractsV3.SealedNegotiationV3, "contracts/SealedNegotiationV3.sol:SealedNegotiationV3"],
        [deployment.contractsV3.SealedTestUSD, "contracts/SealedTestUSD.sol:SealedTestUSD"],
      ]
    : []),
];
(async () => {
  // Newest first: an older build-info can hold an earlier version of the same contract.
  const infos = fs
    .readdirSync(dir)
    .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  for (const [address, id] of targets) {
    const [file, name] = id.split(":");
    const bi = infos.find((b) => b.output?.contracts?.[file]?.[name]);
    const body = { stdJsonInput: bi.input, compilerVersion: bi.solcLongVersion, contractIdentifier: id };
    const r = await fetch(`https://sourcify.dev/server/v2/verify/${deployment.chainId}/${address}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(async () => ({ raw: (await r.text()).slice(0, 200) }));
    console.log(name, r.status, JSON.stringify(j));
  }
})();

