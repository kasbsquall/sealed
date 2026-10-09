import { parseUnits, type Provider } from "ethers";

/**
 * Explicit EIP-1559 fees from the latest block.
 *
 * Monad's base fee has a floor of 100 gwei and moves every block, so the cap is
 * twice the current base plus the tip, which survives a rising block without
 * overpaying: the price actually charged is min(base + tip, cap).
 *
 * Note for anyone tuning gas on Monad: the chain charges the gas LIMIT, not the
 * gas used (docs.monad.xyz, gas pricing). Headroom on a limit is paid for in
 * full, so it is only added where an estimate is known to undershoot.
 */
const FALLBACK_TIP = parseUnits("1", "gwei");
const FALLBACK_BASE = parseUnits("100", "gwei");

export async function chainFees(provider: Provider) {
  const [block, feeData] = await Promise.all([provider.getBlock("latest"), provider.getFeeData()]);
  const base = block?.baseFeePerGas ?? FALLBACK_BASE;
  const tip = feeData.maxPriorityFeePerGas ?? FALLBACK_TIP;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
}
