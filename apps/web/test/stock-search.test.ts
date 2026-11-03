import { describe, expect, it } from 'vitest';

import { matchesStock } from '@/app/(app)/console/lib/rwa';

const spacex = { symbol: 'SPCX', name: 'Space Exploration Technologies Corp. Class A Common Stock • Robinhood Token' };
const spy = { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust • Robinhood Token' };

describe('matchesStock', () => {
  it('finds a stock by the name people use for it', () => {
    for (const search of ['SpaceX', 'spacex', 'Space X', 'SPCX', 'space exploration']) {
      expect(matchesStock(spacex, search)).toBe(true);
    }
    expect(matchesStock({ symbol: 'GOOGL', name: 'Alphabet Inc. Class A' }, 'google')).toBe(true);
  });

  it('ignores punctuation and spacing on both sides', () => {
    expect(matchesStock(spy, 'S&P 500')).toBe(true);
    expect(matchesStock(spy, 's&p500')).toBe(true);
  });

  it('leaves out stocks that do not match', () => {
    expect(matchesStock(spy, 'SpaceX')).toBe(false);
    expect(matchesStock({ symbol: 'TSLA', name: undefined }, 'apple')).toBe(false);
  });
});
