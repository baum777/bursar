'use client';

import { useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from 'react';

export type ChartDay = {
  readonly day: string;
  /** "Nov 2", formatted on the server so both renders agree. */
  readonly label: string;
  readonly payments: number;
  /** Whole USDG, for bar heights. */
  readonly volume: number;
  /** The same amount to the cent, for reading. */
  readonly volumeText: string;
};

const compactUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

/**
 * Settled payments per day and the USDG they carried, as two plots on one time axis. Two measures
 * in two units get two scales, never two axes on one plot. Pointer, arrow keys and the table
 * underneath all read the same days.
 */
export function DailyChart({ days }: { readonly days: readonly ChartDay[] }) {
  const [active, setActive] = useState<number | null>(null);
  const columns = useRef<HTMLDivElement>(null);
  const shown = active === null ? undefined : days[active];

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = columns.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return;
    const index = Math.floor(((event.clientX - box.left) / box.width) * days.length);
    setActive(index < 0 || index >= days.length ? null : index);
  };

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = days.length - 1;
    const next =
      event.key === 'ArrowLeft' ? Math.max(0, (active ?? last + 1) - 1)
      : event.key === 'ArrowRight' ? Math.min(last, (active ?? -1) + 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <div>
      <div
        role="group"
        tabIndex={0}
        aria-label={`Payments settled each day over the last ${days.length} days. Use the arrow keys to read a day.`}
        className="relative outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)]"
        onPointerMove={pick}
        onPointerLeave={() => setActive(null)}
        onKeyDown={step}
        onFocus={() => setActive((current) => current ?? days.length - 1)}
        onBlur={() => setActive(null)}
      >
        <Plot title="Payments settled" values={days.map((d) => d.payments)} whole active={active} columns={columns} />
        <Plot title="USDG settled" values={days.map((d) => d.volume)} active={active} />
        <div className="ml-14 mt-2 flex text-note text-[color:var(--color-muted)]" aria-hidden="true">
          {days.map((d, index) => (
            <div key={d.day} className="relative flex-1">
              {(index === 0 || index === Math.floor((days.length - 1) / 2) || index === days.length - 1) && (
                <span
                  className={`absolute top-0 whitespace-nowrap ${index === 0 ? 'left-0' : index === days.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}
                >
                  {d.label}
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="h-5" />

        {shown !== undefined && active !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max border border-[color:var(--color-line-strong)] bg-surface px-3 py-2 text-detail"
            style={tooltipPosition(active, days.length)}
          >
            <div className="text-[color:var(--color-muted)]">{shown.label}</div>
            <div>
              <span className="font-medium tabular">{shown.payments.toLocaleString('en-US')}</span> {shown.payments === 1 ? 'payment' : 'payments'}
            </div>
            <div>
              <span className="font-medium tabular">{shown.volumeText}</span> settled
            </div>
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {shown === undefined ? '' : `${shown.label}: ${shown.payments} ${shown.payments === 1 ? 'payment' : 'payments'}, ${shown.volumeText} settled.`}
        </p>
      </div>

      <details className="mt-2 text-detail">
        <summary className="cursor-pointer text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)]">Show the figures as a table</summary>
        <table className="mt-3 w-full border-collapse text-sm">
          <caption className="sr-only">Payments settled each day</caption>
          <thead>
            <tr className="border-b border-[color:var(--color-line-strong)] text-left text-detail text-[color:var(--color-muted)]">
              <th scope="col" className="py-2 pr-3 font-normal">Day</th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">Payments</th>
              <th scope="col" className="py-2 text-right font-normal">USDG settled</th>
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.day} className="border-b border-[color:var(--color-line)] last:border-0">
                <td className="py-2 pr-3">{d.label}</td>
                <td className="py-2 pr-3 text-right tabular">{d.payments.toLocaleString('en-US')}</td>
                <td className="py-2 text-right tabular">{d.volumeText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Plot({
  title,
  values,
  whole = false,
  active,
  columns,
}: {
  readonly title: string;
  readonly values: readonly number[];
  readonly whole?: boolean;
  readonly active: number | null;
  readonly columns?: RefObject<HTMLDivElement | null>;
}) {
  const top = ceiling(Math.max(0, ...values), whole);
  const ticks = whole && top % 2 !== 0 ? [0, top] : [0, top / 2, top];
  const label = (value: number) => (whole ? value.toLocaleString('en-US') : compactUsd.format(value));

  return (
    <div className="mb-5" aria-hidden="true">
      <div className="mb-2 text-detail text-[color:var(--color-muted)]">{title}</div>
      <div className="relative ml-14 h-28">
        {ticks.map((tick) => (
          <div key={tick} className="absolute inset-x-0 border-t border-[color:var(--color-line)]" style={{ bottom: `${(tick / top) * 100}%` }}>
            <span className="absolute -left-14 -top-2 w-12 text-right text-note tabular text-[color:var(--color-muted)]">{label(tick)}</span>
          </div>
        ))}
        <div ref={columns} className="absolute inset-0 flex items-end gap-[2px]">
          {values.map((value, index) => (
            <div
              key={index}
              className={`flex h-full flex-1 items-end justify-center ${index === active ? 'bg-[color:var(--color-raised)]' : ''}`}
            >
              {value > 0 && (
                <div className="w-full max-w-6 bg-[color:var(--color-primary)]" style={{ height: `max(2px, ${(value / top) * 100}%)` }} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A round top for the axis: 1, 2, 2.5 or 5 times a power of ten, whole for a count. */
function ceiling(value: number, whole: boolean): number {
  if (value <= 0) return whole ? 2 : 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const top = [1, 2, 2.5, 5, 10].map((step) => step * power).find((candidate) => candidate >= value) ?? value;
  return whole ? Math.max(2, Math.ceil(top)) : top;
}

/** Beside the day, flipped to its left past the middle so it never leaves the chart. */
function tooltipPosition(index: number, count: number): CSSProperties {
  const centre = ((index + 0.5) / count) * 100;
  return index < count / 2
    ? { left: `calc(3.5rem + (100% - 3.5rem) * ${centre / 100} + 12px)` }
    : { right: `calc((100% - 3.5rem) * ${(100 - centre) / 100} + 12px)` };
}
