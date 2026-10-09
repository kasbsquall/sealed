import type { Filter, JsonRpcProvider, Log } from "ethers";

/**
 * The public Monad testnet RPC answers eth_getLogs for 101 blocks and returns
 * 413 for 200 (probed 2026-10-08). 100 stays inside it. Monad makes a block
 * roughly every 0.4 s, so a five-minute negotiation spans ~750 blocks.
 */
const MAX_LOG_RANGE = 100;

/** eth_getLogs over any block range, split into windows the public RPC accepts. */
export async function getLogsChunked(provider: JsonRpcProvider, filter: Omit<Filter, "fromBlock" | "toBlock">, fromBlock: number, toBlock: number): Promise<Log[]> {
  const logs: Log[] = [];
  for (let from = fromBlock; from <= toBlock; from += MAX_LOG_RANGE) {
    logs.push(...(await provider.getLogs({ ...filter, fromBlock: from, toBlock: Math.min(from + MAX_LOG_RANGE - 1, toBlock) })));
  }
  return logs;
}
