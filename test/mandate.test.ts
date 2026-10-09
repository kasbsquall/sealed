import { expect } from "chai";
import { buildMandateRules } from "../agents/privy/mandate";

/**
 * The Privy mandate is the reason an autonomous negotiator is safe to run, so
 * what it allows is tested here as data, without calling Privy.
 *
 * `allowed` is a small evaluator with the same semantics Privy documents for
 * policies: a request passes if at least one ALLOW rule for its method has all
 * of its conditions satisfied; anything no rule matches is denied.
 */

const SEALED = "0x1111111111111111111111111111111111111111";
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const CHAIN = 10143;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const REGISTER_CALLDATA_NAME = "register";

type Request =
  | { method: "eth_sendTransaction" | "eth_signTransaction"; to: string; chainId: number; value: string; functionName?: string }
  | { method: "eth_signTypedData_v4"; verifyingContract: string; chainId: number };

const rules = buildMandateRules({ sealedAddress: SEALED, chainId: CHAIN, identityRegistry: IDENTITY, reputationRegistry: REPUTATION });

function conditionHolds(condition: any, request: Request): boolean {
  const actual = (() => {
    if (condition.field_source === "ethereum_transaction" && "to" in request) {
      if (condition.field === "to") return request.to.toLowerCase();
      if (condition.field === "chain_id") return String(request.chainId);
      if (condition.field === "value") return request.value;
    }
    if (condition.field_source === "ethereum_calldata" && "to" in request) return request.functionName;
    if (condition.field_source === "ethereum_typed_data_domain" && "verifyingContract" in request) {
      if (condition.field === "verifyingContract") return request.verifyingContract.toLowerCase();
      if (condition.field === "chainId") return String(request.chainId);
    }
    return undefined;
  })();
  if (condition.operator !== "eq") throw new Error(`evaluator does not model operator ${condition.operator}`);
  return actual === condition.value;
}

function allowed(request: Request): boolean {
  return rules.some(
    (rule) => rule.action === "ALLOW" && rule.method === request.method && rule.conditions.every((c: any) => conditionHolds(c, request)),
  );
}

describe("Privy mandate", () => {
  describe("what a negotiator may do", () => {
    for (const method of ["eth_sendTransaction", "eth_signTransaction"] as const) {
      it(`may call SealedNegotiation on Monad (${method})`, () => {
        expect(allowed({ method, to: SEALED, chainId: CHAIN, value: "0x0" })).to.equal(true);
      });

      it(`may register its own ERC-8004 identity (${method})`, () => {
        expect(allowed({ method, to: IDENTITY, chainId: CHAIN, value: "0x0", functionName: REGISTER_CALLDATA_NAME })).to.equal(true);
      });

      it(`may rate a counterparty in the ERC-8004 Reputation Registry (${method})`, () => {
        expect(allowed({ method, to: REPUTATION, chainId: CHAIN, value: "0x0", functionName: "giveFeedback" })).to.equal(true);
      });
    }

    it("may sign a Sealed settlement authorization", () => {
      expect(allowed({ method: "eth_signTypedData_v4", verifyingContract: SEALED, chainId: CHAIN })).to.equal(true);
    });
  });

  describe("what a compromised negotiator still cannot do", () => {
    it("cannot send MON anywhere, not even to the Sealed contract", () => {
      expect(allowed({ method: "eth_sendTransaction", to: SEALED, chainId: CHAIN, value: "0x1" })).to.equal(false);
      expect(allowed({ method: "eth_sendTransaction", to: "0x2222222222222222222222222222222222222222", chainId: CHAIN, value: "0x1" })).to.equal(false);
    });

    it("cannot call any other contract", () => {
      expect(allowed({ method: "eth_sendTransaction", to: PERMIT2, chainId: CHAIN, value: "0x0" })).to.equal(false);
    });

    it("cannot call anything on the Identity Registry except register", () => {
      expect(allowed({ method: "eth_sendTransaction", to: IDENTITY, chainId: CHAIN, value: "0x0", functionName: "setAgentWallet" })).to.equal(false);
      expect(allowed({ method: "eth_sendTransaction", to: IDENTITY, chainId: CHAIN, value: "0x0", functionName: "transferFrom" })).to.equal(false);
    });

    it("cannot revoke feedback or do anything else on the Reputation Registry", () => {
      expect(allowed({ method: "eth_sendTransaction", to: REPUTATION, chainId: CHAIN, value: "0x0", functionName: "revokeFeedback" })).to.equal(false);
      expect(allowed({ method: "eth_sendTransaction", to: REPUTATION, chainId: CHAIN, value: "0x0", functionName: "appendResponse" })).to.equal(false);
    });

    it("cannot use its mandate on another chain", () => {
      expect(allowed({ method: "eth_sendTransaction", to: SEALED, chainId: 143, value: "0x0" })).to.equal(false);
      expect(allowed({ method: "eth_signTypedData_v4", verifyingContract: SEALED, chainId: 1 })).to.equal(false);
    });

    it("cannot sign a Permit2 approval or any other protocol's typed data", () => {
      expect(allowed({ method: "eth_signTypedData_v4", verifyingContract: PERMIT2, chainId: CHAIN })).to.equal(false);
    });

    it("cannot get a transaction signed by switching to eth_signTransaction", () => {
      // The self-broadcast path must be exactly as bounded as Privy's own.
      expect(allowed({ method: "eth_signTransaction", to: PERMIT2, chainId: CHAIN, value: "0x0" })).to.equal(false);
      expect(allowed({ method: "eth_signTransaction", to: SEALED, chainId: CHAIN, value: "0x1" })).to.equal(false);
    });
  });

  describe("shape", () => {
    it("is ALLOW-only, so everything else falls to Privy's default deny", () => {
      expect(rules.every((r) => r.action === "ALLOW")).to.equal(true);
    });

    it("gives eth_sendTransaction and eth_signTransaction identical conditions", () => {
      const conditionsFor = (method: string) =>
        JSON.stringify(rules.filter((r) => r.method === method).map((r) => r.conditions));
      expect(conditionsFor("eth_signTransaction")).to.equal(conditionsFor("eth_sendTransaction"));
    });

    it("keeps every rule name under the 50 characters Privy accepts", () => {
      // Privy rejects the whole policy with invalid_policy_format otherwise.
      for (const rule of rules) expect(rule.name.length, rule.name).to.be.below(50);
    });

    it("omits the register rule when no Identity Registry is given", () => {
      const bare = buildMandateRules({ sealedAddress: SEALED, chainId: CHAIN });
      expect(bare.some((r) => r.name.includes("register"))).to.equal(false);
    });
  });
});
