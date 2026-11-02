import type { Micro } from '@bursar/core';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { explorerAddress, explorerTx, shortAddress } from '@/chain/rhc';
import { Instant } from '@/components/instant';
import { Card, Section } from '@/components/layout';
import { usd } from '@/money';
import type { PaymentStatus } from './aggregate';
import { DailyChart } from './daily-chart';
import type { RecentPayment, Stats } from './read';

const STATUS: Readonly<Record<PaymentStatus, string>> = {
  held: 'In escrow',
  disputed: 'Disputed',
  settled: 'Settled',
  refunded: 'Refunded',
  ruled: 'Ruled',
};

/**
 * Server-rendered, so the figures arrive with the page. Each section is drawn only when it has
 * something to say; a read that came back short leaves its section out rather than showing a gap.
 */
export function StatsView({ stats }: { readonly stats: Stats }) {
  const { payments, mandates, providers, endowments } = stats;
  const daily = stats.daily?.some((day) => day.payments > 0) ? stats.daily : undefined;
  const recent = stats.recent !== undefined && stats.recent.length > 0 ? stats.recent : undefined;
  const reach = [
    mandates && <Figure key="mandates" label="Mandates" value={count(mandates.count)} hint="Spending accounts that hold an agent to its limits" />,
    mandates?.held !== undefined && (
      <Figure
        key="held"
        label="Held in mandates"
        value={usd(mandates.held as Micro)}
        hint={mandates.heldAcross === undefined ? 'USDG agents can spend now' : `USDG in the ${count(mandates.heldAcross)} newest mandates`}
      />
    ),
    providers && <Figure key="registered" label="Providers registered" value={count(providers.registered)} hint="Staked and open to take payments" />,
    endowments !== undefined && endowments.count > 0 && (
      <Figure
        key="endowments"
        label="Endowments"
        value={count(endowments.count)}
        hint={endowments.principal === undefined ? 'Agents funded from invested principal' : `${usd(endowments.principal as Micro)} invested for agents`}
      />
    ),
  ].filter(Boolean);

  return (
    <div className="space-y-10">
      <Section
        title="What agents have paid through Bursar"
        description="Agents pay providers in USDG, held in escrow until the work is delivered. Every figure here is read from the Bursar contracts on Robinhood Chain and refreshed every five minutes."
      >
        {payments && (
          <Card title="Payments">
            <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
              <Figure label="Settled" value={usd(payments.settled.volume as Micro)} hint={`${plural(payments.settled.count, 'payment')} released to providers`} />
              <Figure label="In escrow now" value={usd(payments.held.amount as Micro)} hint={`${plural(payments.held.count, 'payment')} awaiting delivery or a ruling`} />
              <Figure label="Providers paid" value={count(payments.providersPaid)} hint="Addresses that have received a payment" />
              <Figure label="Disputes opened" value={count(payments.disputes.opened)} hint={`${count(payments.disputes.ruled)} ruled by resolvers`} />
            </div>
            {payments.operatedShare !== undefined && (
              <p className="mt-5 border-t border-[color:var(--color-line)] pt-4 text-detail">
                Includes payments by agents Bursar runs: {percent(payments.operatedShare)}.
              </p>
            )}
          </Card>
        )}
        {reach.length > 0 && (
          <Card title="Mandates and providers">
            <div className="grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">{reach}</div>
          </Card>
        )}
      </Section>

      {daily && (
        <Section title={`The last ${daily.length} days`} description="Payments settled each day and the USDG they carried, by UTC day.">
          <Card>
            <DailyChart
              days={daily.map((day) => ({
                day: day.day,
                label: dayLabel(day.day),
                payments: day.payments,
                volume: Number(day.volume) / 1e6,
                volumeText: usd(day.volume as Micro),
              }))}
            />
          </Card>
        </Section>
      )}

      {recent && (
        <Section title="Recent payments" description="The newest payments into escrow and where each one stands.">
          <Card>
            <RecentTable rows={recent} />
          </Card>
        </Section>
      )}

      {stats.block > 0n && (
        <p className="text-note text-[color:var(--color-muted)]">
          Updated <Instant at={new Date(stats.readAt)} relative /> at block {stats.block.toString()}.
        </p>
      )}
    </div>
  );
}

function Figure({ label, value, hint }: { readonly label: string; readonly value: ReactNode; readonly hint?: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-detail text-[color:var(--color-muted)]">{label}</div>
      <div className="text-xl leading-tight tracking-[-0.02em]">{value}</div>
      {hint && <div className="text-note text-[color:var(--color-muted)]">{hint}</div>}
    </div>
  );
}

function RecentTable({ rows }: { readonly rows: readonly RecentPayment[] }) {
  const header = 'px-3 pb-2.5 pt-1 text-detail font-normal text-[color:var(--color-muted)]';
  const link = 'underline decoration-[color:var(--color-line-strong)] underline-offset-2 hover:decoration-[color:var(--color-ink)]';

  return (
    <div className="-mx-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Recent payments</caption>
        <thead>
          <tr className="border-b border-[color:var(--color-line-strong)] text-left">
            <th scope="col" className={header}>Paid</th>
            <th scope="col" className={`${header} text-right`}>Amount</th>
            <th scope="col" className={header}>Status</th>
            <th scope="col" className={`${header} hidden sm:table-cell`}>Provider</th>
            <th scope="col" className={`${header} hidden sm:table-cell`}>From</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tx} className="border-b border-[color:var(--color-line)] last:border-0">
              <td className="whitespace-nowrap px-3 py-3">
                <a href={explorerTx(row.tx)} target="_blank" rel="noreferrer" className={link}>
                  <Instant at={new Date(row.at * 1000)} relative />
                </a>
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-right tabular">{usd(row.amount as Micro)}</td>
              <td className="whitespace-nowrap px-3 py-3">{STATUS[row.status]}</td>
              <td className="hidden px-3 py-3 sm:table-cell">
                <Link href={`/providers/${row.payee}`} className={`tabular text-detail ${link}`} title={row.payee}>
                  {shortAddress(row.payee)}
                </Link>
              </td>
              <td className="hidden px-3 py-3 sm:table-cell">
                {row.payerIsMandate ? (
                  <Link href={`/console/${row.payer}`} className={`tabular text-detail ${link}`} title={row.payer}>
                    {shortAddress(row.payer)}
                  </Link>
                ) : (
                  <a href={explorerAddress(row.payer)} target="_blank" rel="noreferrer" className={`tabular text-detail ${link}`} title={row.payer}>
                    {shortAddress(row.payer)}
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(value: number, noun: string): string {
  return `${count(value)} ${value === 1 ? noun : `${noun}s`}`;
}

function percent(share: number): string {
  return share > 0 && share < 0.005 ? 'under 1%' : `${Math.round(share * 100)}%`;
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
