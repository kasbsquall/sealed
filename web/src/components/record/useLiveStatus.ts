"use client";

import { useEffect, useState } from "react";
import type { Run } from "@/lib/data";

/** Monad's public testnet RPC. Only eth_call is used here; it caps eth_getLogs at 100 blocks per call. */
const RPC = "https://testnet-rpc.monad.xyz";
/** keccak256("getNegotiation(uint256)")[0..4] */
const GET_NEGOTIATION = "0x8a14e660";
const STATUS = ["None", "Open", "Locked", "Settled", "Expired"];
// Negotiation is a static struct: twelve 32-byte words. status is word 9, settledPrice word 10.
const STATUS_WORD = 9;
const PRICE_WORD = 10;

export type Live = { state: "loading" } | { state: "error" } | { state: "ok"; status: string; price: string };

const TIMEOUT_MS = 8000;

const word = (hex: string, i: number) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));

/** Reads each featured negotiation straight from the contract, so the page does not only repeat the transcript. */
export function useLiveStatus(runs: Run[]): Record<string, Live> {
  const [live, setLive] = useState<Record<string, Live>>({});

  useEffect(() => {
    const controller = new AbortController();
    const read = async (run: Run): Promise<Live> => {
      const id = BigInt(run.negotiationId).toString(16).padStart(64, "0");
      const response = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: run.contract, data: GET_NEGOTIATION + id }, "latest"],
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!response.ok) return { state: "error" };
      const body = await response.json();
      if (typeof body.result !== "string" || body.result.length < 2 + 12 * 64) return { state: "error" };
      return {
        state: "ok",
        status: STATUS[Number(word(body.result, STATUS_WORD))] ?? "Unknown",
        price: word(body.result, PRICE_WORD).toString(),
      };
    };

    for (const run of runs) {
      read(run)
        .then((result) => {
          if (!controller.signal.aborted) setLive((prev) => ({ ...prev, [run.negotiationId]: result }));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setLive((prev) => ({ ...prev, [run.negotiationId]: { state: "error" } }));
        });
    }
    return () => controller.abort();
  }, [runs]);

  return live;
}
