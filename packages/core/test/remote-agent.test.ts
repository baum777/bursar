import { describe, expect, it } from 'vitest';

import { REMOTE_AGENT_CHAINS, decodeAgentId, erc8004Registries, remoteAgentId } from '../src/index.js';

describe('agents on other chains', () => {
  it('encodes the chain above the agent and decodes both back', () => {
    const id = remoteAgentId(8453, 795_681n);
    expect(id).toBe((8453n << 160n) | 795_681n);
    expect(decodeAgentId(id, 4663)).toEqual({ chainId: 8453, agentId: 795_681n, remote: true });
    expect(remoteAgentId(1, 795_681n)).not.toBe(id);
  });

  it('reads a local id as the local chain', () => {
    expect(decodeAgentId(8756n, 4663)).toEqual({ chainId: 4663, agentId: 8756n, remote: false });
  });

  it('refuses a chain of zero and an agent past 160 bits', () => {
    expect(() => remoteAgentId(0, 1n)).toThrow(RangeError);
    expect(() => remoteAgentId(8453, 1n << 160n)).toThrow(RangeError);
  });

  it('knows the registries on Base and Ethereum at the Robinhood Chain addresses', () => {
    for (const chain of REMOTE_AGENT_CHAINS) {
      const r = erc8004Registries(chain);
      expect(r?.identity).toBe(erc8004Registries(4663)?.identity);
      expect(r?.reputation).toBe(erc8004Registries(4663)?.reputation);
    }
  });
});
