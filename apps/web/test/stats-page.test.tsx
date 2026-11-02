import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StatsView } from '@/app/(app)/stats/stats-view';
import type { Stats } from '@/app/(app)/stats/read';

const MANDATE = '0x8605853aC6A64dA11F4ED0Ff0Ad128961Cc3cd5c';
const PROVIDER = '0x5210aAaAaaAaaAaaAAaaAaaaAaAAAaAAaAaAa374';
const OUTSIDER = '0x47F1000000000000000000000000000000003F34';

const days = Array.from({ length: 30 }, (_, i) => ({
  day: new Date(Date.UTC(2026, 9, 4 + i)).toISOString().slice(0, 10),
  payments: i === 29 ? 2 : 0,
  volume: i === 29 ? 1_500_000n : 0n,
}));

const FULL: Stats = {
  readAt: Date.parse('2026-11-02T09:00:00Z'),
  block: 104_099_097n,
  payments: {
    settled: { count: 53, volume: 10_700_000n },
    held: { count: 1, amount: 250_000n },
    refunded: { count: 46, amount: 9_050_000n },
    disputes: { opened: 5, ruled: 5 },
    providersPaid: 1,
    operatedShare: 0.4,
  },
  daily: days,
  recent: [
    { amount: 10_000n, payer: MANDATE, payee: PROVIDER, payerIsMandate: true, status: 'settled', tx: `0x${'ab'.repeat(32)}`, at: 1_793_000_000 },
    { amount: 250_000n, payer: OUTSIDER, payee: PROVIDER, payerIsMandate: false, status: 'held', tx: `0x${'cd'.repeat(32)}`, at: 1_792_999_000 },
  ],
  mandates: { count: 48, held: 5_714_750n },
  providers: { registered: 2 },
  endowments: { count: 2, principal: 5_275_855n },
};

const render = (stats: Stats) => renderToStaticMarkup(<StatsView stats={stats} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the stats page', () => {
  const html = render(FULL);
  const page = text(html);

  it('leads with what was settled, held and refunded', () => {
    expect(page).toContain('Settled $10.70 53 payments released to providers');
    expect(page).toContain('In escrow now $0.25 1 payment awaiting delivery or a ruling');
    expect(page).toContain('Refunded $9.05 46 payments returned to the payer');
    expect(page).toContain('Disputes opened 5 5 ruled by resolvers');
  });

  it('shows mandates, providers and endowments', () => {
    expect(page).toContain('Mandates 48');
    expect(page).toContain('Held in mandates $5.71 USDG agents can spend now');
    expect(page).toContain('Providers registered 2');
    expect(page).toContain('Providers paid 1');
    expect(page).toContain('Endowments 2 $5.28 invested for agents');
  });

  it('says in one line how much of it Bursar’s own agents paid', () => {
    expect(page).toContain('Includes payments by agents Bursar runs: 40%.');
    expect(text(render({ ...FULL, payments: { ...FULL.payments!, operatedShare: undefined } }))).not.toContain('Bursar runs');
  });

  it('draws the last thirty days and the table behind them', () => {
    expect(page).toContain('The last 30 days');
    expect(page).toContain('Nov 2 2 $1.50');
  });

  it('links each recent payment to its transaction, its provider and its mandate', () => {
    expect(html).toContain(`/tx/0x${'ab'.repeat(32)}`);
    expect(html).toContain(`href="/providers/${PROVIDER}"`);
    expect(html).toContain(`href="/console/${MANDATE}"`);
    expect(html).toContain(`/address/${OUTSIDER}`);
    expect(page).toContain('In escrow');
  });

  it('leaves out a section with nothing to show, and one it could not read', () => {
    const quiet = text(
      render({
        ...FULL,
        payments: undefined,
        daily: days.map((day) => ({ ...day, payments: 0, volume: 0n })),
        recent: [],
        endowments: { count: 0 },
      }),
    );
    expect(quiet).not.toContain('Settled');
    expect(quiet).not.toContain('Providers paid');
    expect(quiet).not.toContain('The last 30 days');
    expect(quiet).not.toContain('Recent payments');
    expect(quiet).not.toContain('Endowments');
    expect(quiet).toContain('Mandates 48');
  });

  it('says how many mandates a capped balance covers', () => {
    expect(text(render({ ...FULL, mandates: { count: 2_400, held: 1_000_000n, heldAcross: 2_000 } }))).toContain('USDG in the 2,000 newest mandates');
  });

  it('keeps to the house copy: no dashes as connectors and no shouted labels', () => {
    expect(html).not.toMatch(/[—–]/);
    expect(html).not.toContain('uppercase');
  });
});
