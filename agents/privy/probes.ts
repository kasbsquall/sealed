import { PrivyClient } from "@privy-io/node";
import { Interface, ZeroHash } from "ethers";
import { SEALED_EIP712_DOMAIN_NAME, SEALED_EIP712_DOMAIN_VERSION } from "../sealed/commitment";
import type { AgentWallet } from "./agentWallet";

/**
 * Requests sent to a live Privy wallet under the Sealed mandate, to show what
 * the policy does rather than describe it. Most are things a hijacked agent
 * would try, and Privy must refuse them; two are what a negotiator really
 * does, and Privy must sign them. Nothing allowed here is broadcast: the
 * signed transaction uses nonce 0, which the wallet spent long ago, and the
 * settlement authorization covers two zero commitments that do not exist.
 *
 * Only Privy's own refusal counts: its error code is `policy_violation`. Any
 * other error means the policy was never evaluated, so that probe is reported
 * as inconclusive and claims nothing.
 */

export interface ProbeRecord {
  /** Stable name of the probe; the wording below can change between runs. */
  id: string;
  attempted: string;
  /** What the request would let an attacker do, in plain words. */
  label: string;
  expect: "refused" | "allowed";
  refused: boolean;
  response: string;
}

export interface ProbeContext {
  privy: PrivyClient;
  walletId: string;
  authorizationPrivateKey: string;
  chainId: number;
  sealed: string;
  identityRegistry: string;
  /** Any address outside the mandate: the demo relayer. */
  outsider: string;
  /** The same wallet as `walletId`, for the request a negotiator really makes. */
  agentWallet: AgentWallet;
  /**
   * A negotiation the wallet took part in. Without one, the two allowed probes
   * are left out, since they would name a negotiation the wallet never joined.
   */
  negotiationId?: bigint;
}

interface Probe {
  id: string;
  attempted: string;
  label: string;
  expect: "refused" | "allowed";
  run: () => Promise<unknown>;
}

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const SIGN_ONLY = { type: 2 as const, nonce: "0x0", gas_limit: "0x30d40", max_fee_per_gas: "0x174876e800", max_priority_fee_per_gas: "0x3b9aca00" };
const sealedInterface = new Interface(["function expire(uint256 negotiationId)"]);
const erc721Interface = new Interface(["function approve(address to, uint256 tokenId)"]);

const SETTLE_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  SettleAuthorization: [
    { name: "negotiationId", type: "uint256" },
    { name: "buyerCommitment", type: "bytes32" },
    { name: "sellerCommitment", type: "bytes32" },
    { name: "buyerCommitIndex", type: "uint32" },
    { name: "sellerCommitIndex", type: "uint32" },
  ],
};

export function mandateProbes(ctx: ProbeContext): Probe[] {
  const { privy, walletId, chainId, sealed, outsider } = ctx;
  const eth = () => privy.wallets().ethereum();
  const auth = { authorization_private_keys: [ctx.authorizationPrivateKey] };
  const signTx = (transaction: Record<string, unknown>) =>
    eth().signTransaction(walletId, { params: { transaction: { ...SIGN_ONLY, ...transaction } }, authorization_context: auth });
  const negotiationId = ctx.negotiationId ?? 0n;
  const settleMessage = { negotiationId: negotiationId.toString(), buyerCommitment: ZeroHash, sellerCommitment: ZeroHash, buyerCommitIndex: 0, sellerCommitIndex: 0 };
  const signSettle = (verifyingContract: string, signChainId: number) =>
    eth().signTypedData(walletId, {
      params: {
        typed_data: {
          domain: { name: SEALED_EIP712_DOMAIN_NAME, version: SEALED_EIP712_DOMAIN_VERSION, chainId: signChainId, verifyingContract },
          types: SETTLE_TYPES,
          primary_type: "SettleAuthorization",
          message: settleMessage,
        },
      },
      authorization_context: auth,
    });

  const probes: Probe[] = [
    // The first three ran with the Privy demo on 2026-10-09; their wording is
    // kept so the recorded results still match.
    {
      id: "transfer",
      attempted: `eth_sendTransaction: 1 wei from the buyer wallet to ${outsider}`,
      label: "Send 1 wei of MON to another address",
      expect: "refused",
      run: () =>
        eth().sendTransaction(walletId, {
          caip2: `eip155:${chainId}`,
          params: { transaction: { to: outsider, value: "0x1", chain_id: chainId } },
          authorization_context: auth,
        }),
    },
    {
      id: "transfer-sign-only",
      attempted: `eth_signTransaction: 1 wei from the buyer wallet to ${outsider}`,
      label: "Sign that same transfer to broadcast it elsewhere",
      expect: "refused",
      run: () => signTx({ to: outsider, value: "0x1", chain_id: chainId, gas_limit: "0x5208" }),
    },
    {
      id: "permit2",
      attempted: "eth_signTypedData_v4: a Permit2 PermitSingle approving the relayer to spend the buyer's tokens",
      label: "Sign a Permit2 approval letting someone spend its tokens",
      expect: "refused",
      run: () =>
        eth().signTypedData(walletId, {
          params: {
            typed_data: {
              domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
              types: {
                EIP712Domain: [
                  { name: "name", type: "string" },
                  { name: "chainId", type: "uint256" },
                  { name: "verifyingContract", type: "address" },
                ],
                PermitDetails: [
                  { name: "token", type: "address" },
                  { name: "amount", type: "uint160" },
                  { name: "expiration", type: "uint48" },
                  { name: "nonce", type: "uint48" },
                ],
                PermitSingle: [
                  { name: "details", type: "PermitDetails" },
                  { name: "spender", type: "address" },
                  { name: "sigDeadline", type: "uint256" },
                ],
              },
              primary_type: "PermitSingle",
              message: {
                details: { token: outsider, amount: "1461501637330902918203684832716283019655932542975", expiration: "281474976710655", nonce: "0" },
                spender: outsider,
                sigDeadline: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
              },
            },
          },
          authorization_context: auth,
        }),
    },
    {
      id: "sealed-with-value",
      attempted: `eth_signTransaction: a call to SealedNegotiation ${sealed} carrying 1 wei`,
      label: "Attach MON to a call to the Sealed contract itself",
      expect: "refused",
      run: () => signTx({ to: sealed, value: "0x1", chain_id: chainId, data: sealedInterface.encodeFunctionData("expire", [negotiationId]) }),
    },
    {
      id: "sealed-other-chain",
      attempted: `eth_signTransaction: a call to SealedNegotiation ${sealed} with chain_id 1 (Ethereum mainnet)`,
      label: "Sign a Sealed call for a different chain",
      expect: "refused",
      run: () => signTx({ to: sealed, value: "0x0", chain_id: 1, data: sealedInterface.encodeFunctionData("expire", [negotiationId]) }),
    },
    {
      id: "identity-approve",
      attempted: `eth_signTransaction: approve(${outsider}, agentId) on the ERC-8004 Identity Registry ${ctx.identityRegistry}`,
      label: "Approve someone to take its ERC-8004 identity",
      expect: "refused",
      run: () => signTx({ to: ctx.identityRegistry, value: "0x0", chain_id: chainId, data: erc721Interface.encodeFunctionData("approve", [outsider, 1n]) }),
    },
    {
      id: "lookalike-domain",
      attempted: `eth_signTypedData_v4: a Sealed SettleAuthorization whose verifyingContract is ${outsider}`,
      label: "Sign a Sealed-looking payload for a lookalike contract",
      expect: "refused",
      run: () => signSettle(outsider, chainId),
    },
    {
      id: "sealed-other-chain-typed",
      attempted: "eth_signTypedData_v4: a Sealed SettleAuthorization for the real contract with chainId 1",
      label: "Sign a real Sealed payload for replay on another chain",
      expect: "refused",
      run: () => signSettle(sealed, 1),
    },
    {
      id: "personal-sign",
      attempted: 'personal_sign: "Sign in to claim your MON airdrop"',
      label: "Sign a free-text login message",
      expect: "refused",
      run: () => eth().signMessage(walletId, { message: "Sign in to claim your MON airdrop", authorization_context: auth }),
    },
    {
      id: "eip7702-delegation",
      attempted: `eth_sign7702Authorization: delegate the wallet's code to ${outsider}`,
      label: "Delegate the whole wallet to another contract (EIP-7702)",
      expect: "refused",
      run: () =>
        eth().sign7702Authorization(walletId, {
          params: { contract: outsider, chain_id: chainId },
          authorization_context: auth,
        }),
    },
    {
      id: "sealed-call",
      attempted: `eth_signTransaction: expire(${negotiationId}) on SealedNegotiation ${sealed}, chain ${chainId}, zero value, never broadcast`,
      label: "Sign a call to the Sealed contract",
      expect: "allowed",
      run: async () => {
        await signTx({ to: sealed, value: "0x0", chain_id: chainId, data: sealedInterface.encodeFunctionData("expire", [negotiationId]) });
        return "signed, nonce 0, not broadcast";
      },
    },
    {
      id: "settle-authorization",
      attempted: `eth_signTypedData_v4: a Sealed SettleAuthorization for negotiation ${negotiationId} over two zero commitments, through AgentWallet`,
      label: "Sign a Sealed settlement authorization",
      expect: "allowed",
      run: async () => {
        await ctx.agentWallet.authorizeSettlement({ ...settleMessage, negotiationId: negotiationId });
        return "signature returned, not stored";
      },
    },
  ];
  return ctx.negotiationId === undefined ? probes.filter((p) => p.expect === "refused") : probes;
}

/**
 * Runs every probe not yet recorded and fills in the label and expectation of
 * the ones that are. A record is matched by the probe's stable `id`, or by its
 * exact wording for records made before ids existed. Every save keeps all
 * earlier records, so an interrupted run loses nothing and resumes where it
 * stopped.
 *
 * Whatever Privy returns when it signs is never stored: a probe that should
 * have been refused and was signed would otherwise publish a usable signature.
 */
export async function runMandateProbes(
  probes: Probe[],
  recorded: (Pick<ProbeRecord, "attempted" | "refused" | "response"> & { id?: string })[],
  save: (records: ProbeRecord[]) => void,
): Promise<{ records: ProbeRecord[]; inconclusive: { attempted: string; error: string }[] }> {
  const previousOf = (probe: Probe) => recorded.find((r) => r.id === probe.id || r.attempted === probe.attempted);
  const done = new Map<string, ProbeRecord>();
  const snapshot = () => {
    const current = probes.flatMap((p) => done.get(p.id) ?? []);
    const untouched = recorded.filter((r) => !probes.some((p) => previousOf(p) === r)) as ProbeRecord[];
    return [...current, ...untouched];
  };
  const inconclusive: { attempted: string; error: string }[] = [];
  for (const probe of probes) {
    const base = { id: probe.id, attempted: probe.attempted, label: probe.label, expect: probe.expect };
    const previous = previousOf(probe);
    if (previous) {
      done.set(probe.id, { ...base, attempted: previous.attempted, refused: previous.refused, response: previous.response });
      continue;
    }
    try {
      const result = await probe.run();
      const response = typeof result === "string" ? result : "signed (response withheld)";
      done.set(probe.id, { ...base, refused: false, response });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!/policy[_ ]violation/i.test(message)) {
        inconclusive.push({ attempted: probe.attempted, error: message.slice(0, 300) });
        continue;
      }
      done.set(probe.id, { ...base, refused: true, response: message.slice(0, 400) });
    }
    save(snapshot());
  }
  const records = snapshot();
  save(records);
  return { records, inconclusive };
}

/**
 * True only when every probe was answered and ended the way the mandate says.
 * An inconclusive probe, or one never sent, fails it: an empty run proves nothing.
 */
export const probesHold = (probes: Pick<Probe, "id">[], records: ProbeRecord[], inconclusive: unknown[]) =>
  inconclusive.length === 0 &&
  probes.every((p) => records.some((r) => r.id === p.id)) &&
  records.every((r) => r.refused === (r.expect === "refused"));
