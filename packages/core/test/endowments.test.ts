import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';

import { BASE_LANE, endowmentFactories, endowmentsDeployment } from '../src/index.js';

describe('endowment factories', () => {
  it('lists the current factory first and keeps the earlier ones, once each', () => {
    const factories = endowmentFactories(4663);
    expect(factories[0]).toBe(endowmentsDeployment(4663)?.EndowmentFactory);
    expect(factories).toContain('0x3b1AF2d844C47913d90D6BDA278C6ccC92466326');
    expect(factories).toContain('0xE3efEd60E6c96dF216372654Bc1B5a7cF986a5b0');
    expect(factories).toContain('0x18a4961C3e5c201e76cdD580c22BB2a3cd3d3E6c');
    expect(new Set(factories.map((f) => f.toLowerCase())).size).toBe(factories.length);
  });

  it('knows none on a chain with no record', () => {
    expect(endowmentFactories(1)).toEqual([]);
  });
});

describe('the Base lane', () => {
  it('names one checksummed float and the earnings surface under the facilitator', () => {
    expect(BASE_LANE.float).toBe(getAddress(BASE_LANE.float));
    expect(BASE_LANE.earn).toBe(`${BASE_LANE.facilitator}/base/earn`);
  });
});
