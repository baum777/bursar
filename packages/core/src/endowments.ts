import { currentSetDeployments } from './contract-set.js';
import type { EndowmentsDeployment } from './deployment-record.js';

/**
 * The endowment factory that answers for a chain, if deployed: the newest record carrying one
 * within the contract set that answers for the chain.
 */
export function endowmentsDeployment(chainId: number): EndowmentsDeployment | undefined {
  return currentSetDeployments(chainId).find((d) => d.endowments !== undefined)?.endowments;
}

/**
 * Every endowment factory that answers for a chain, newest first: the current one and the earlier
 * ones a record keeps because their endowments still run. An address any of them reports through
 * `isEndowment` is an endowment Bursar deployed.
 */
export function endowmentFactories(chainId: number): readonly `0x${string}`[] {
  const found: `0x${string}`[] = [];
  for (const d of currentSetDeployments(chainId)) {
    for (const set of [d.endowments, d.endowmentsV2, d.endowmentsV1]) {
      const factory = set?.EndowmentFactory;
      if (factory !== undefined && !found.some((known) => known.toLowerCase() === factory.toLowerCase())) found.push(factory);
    }
  }
  return found;
}
