'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Hex } from 'viem';
import type { Micro } from '@bursar/core';

import { explorerTx } from '@/chain/rhc';
import type { EndowmentView } from '@/chain/endowments';
import { Button } from '@/components/button';
import { TextField } from '@/components/fields';
import { Card, Section } from '@/components/layout';
import { usd } from '@/money';
import { failureLine, isSettled, nextPoll, relayApi } from '@/relay';
import type { RelayStatus } from '@/relay';

/**
 * A gift by card. The console opens a Coinbase Onramp session whose destination is a Relay deposit
 * address on Base that pays this endowment in USDG. The reader pays at Coinbase; Coinbase delivers
 * USDC on Base; Relay turns it into USDG and pays the endowment. Nothing is signed on a chain and
 * no gas is needed. This page follows Relay's request until the gift lands.
 */
const PRESETS = [10, 25, 50, 100] as const;
const STORAGE = 'bursar.card-gift';

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'waiting'; readonly requestId: Hex; readonly dollars: number | undefined; readonly status: RelayStatus | undefined }
  | { readonly kind: 'arrived'; readonly fillHash: string | undefined; readonly landed: Micro | undefined }
  | { readonly kind: 'failed'; readonly reason: string };

export function CardGiftSection({ view, onChange }: { readonly view: EndowmentView; readonly onChange: () => void }) {
  const api = useMemo(() => relayApi({ base: '/api/relay' }), []);
  const [dollars, setDollars] = useState<number>(25);
  const [custom, setCustom] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // A gift left in flight by an earlier page load, or named in the address bar after Coinbase
  // sends the reader back, is followed from where it stands.
  useEffect(() => {
    const carried = recall(view.address);
    if (carried !== undefined) setPhase({ kind: 'waiting', requestId: carried.requestId, dollars: carried.dollars, status: undefined });
  }, [view.address]);

  const chosen = custom.trim() === '' ? dollars : Number(custom.trim());
  const amountProblem = custom.trim() === '' ? undefined : !Number.isInteger(chosen) || chosen < 5 || chosen > 1_000 ? 'Enter a whole number of dollars from 5 to 1,000.' : undefined;

  const open = useCallback(async () => {
    if (amountProblem !== undefined) return;
    setPhase({ kind: 'opening' });
    try {
      const response = await fetch('/api/onramp/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endowment: view.address, dollars: chosen }),
      });
      const body = (await response.json().catch(() => ({}))) as { url?: string; requestId?: string; error?: string; reason?: string };
      if (!response.ok || typeof body.url !== 'string' || typeof body.requestId !== 'string') {
        setPhase({ kind: 'failed', reason: body.reason ?? body.error ?? 'The card session could not be opened.' });
        return;
      }
      const requestId = body.requestId as Hex;
      remember(view.address, { requestId, dollars: chosen });
      window.open(body.url, '_blank', 'noopener');
      setPhase({ kind: 'waiting', requestId, dollars: chosen, status: undefined });
    } catch (error) {
      setPhase({ kind: 'failed', reason: error instanceof Error ? error.message : 'The card session could not be opened.' });
    }
  }, [amountProblem, chosen, view.address]);

  const requestId = phase.kind === 'waiting' ? phase.requestId : undefined;
  const status = useQuery({
    queryKey: ['relay', 'card-gift', requestId],
    queryFn: () => api.status(requestId as Hex),
    enabled: requestId !== undefined,
    refetchInterval: (query) => (requestId === undefined ? false : nextPoll(query.state.data)),
    retry: 2,
  });

  useEffect(() => {
    if (phase.kind !== 'waiting' || status.data === undefined) return;
    const latest = status.data;
    if (!isSettled(latest)) {
      if (latest.phase !== phase.status?.phase) setPhase({ ...phase, status: latest });
      return;
    }
    forget(view.address);
    if (latest.phase === 'success') {
      onChange();
      setPhase({ kind: 'arrived', fillHash: latest.txHashes[0], landed: undefined });
      return;
    }
    setPhase({ kind: 'failed', reason: failureLine(latest, 'Base') });
  }, [status.data, phase, view.address, onChange]);

  const reset = useCallback(() => {
    forget(view.address);
    setPhase({ kind: 'idle' });
  }, [view.address]);

  return (
    <Section
      title="Add with a card"
      description="Pay at Coinbase by card or bank. The gift arrives as USDG on Robinhood Chain and joins the principal; nothing to sign, no gas."
    >
      <Card>
        {phase.kind === 'arrived' ? (
          <div className="space-y-3">
            <p className="text-sm">
              Your gift landed and joined the principal.
              {phase.fillHash !== undefined && (
                <>
                  {' '}
                  <a href={explorerTx(phase.fillHash as Hex)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    View the transaction
                  </a>
                  .
                </>
              )}
            </p>
            <Button onClick={reset}>Give again</Button>
          </div>
        ) : phase.kind === 'waiting' ? (
          <div className="space-y-3">
            <p className="text-sm">
              {phase.dollars !== undefined ? `Finish the ${usd(BigInt(phase.dollars) * 1_000_000n as Micro)} purchase at Coinbase in the tab that opened.` : 'Finish the purchase at Coinbase.'}{' '}
              Coinbase delivers USDC on Base, Relay turns it into USDG and pays the endowment. That usually takes a few minutes after the purchase
              clears, and this page updates by itself.
            </p>
            <p className="text-detail text-[color:var(--color-muted)]">
              {phase.status === undefined
                ? 'Waiting for the purchase to reach Base.'
                : phase.status.phase === 'delayed'
                  ? 'Relay is taking longer than usual. The gift still lands.'
                  : 'The purchase reached Base. Relay is paying the endowment.'}
            </p>
            <button type="button" className="cursor-pointer text-sm underline underline-offset-2" onClick={reset}>
              Start over
            </button>
          </div>
        ) : (
          <div className="max-w-md space-y-3">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button
                  key={preset}
                  tone={custom.trim() === '' && dollars === preset ? 'primary' : 'secondary'}
                  onClick={() => {
                    setCustom('');
                    setDollars(preset);
                  }}
                >
                  ${preset}
                </Button>
              ))}
            </div>
            <div className="max-w-xs">
              <TextField label="Other amount" value={custom} onChange={setCustom} placeholder="Dollars" suffix="USD" {...(amountProblem === undefined ? {} : { problem: amountProblem })} />
            </div>
            {phase.kind === 'failed' && (
              <p className="text-detail" style={{ color: 'var(--color-state-blocked)' }}>
                {phase.reason}
              </p>
            )}
            <Button tone="primary" disabled={phase.kind === 'opening' || amountProblem !== undefined} onClick={() => void open()}>
              {phase.kind === 'opening' ? 'Opening Coinbase' : `Give $${chosen} by card at Coinbase`}
            </Button>
            <p className="text-detail text-[color:var(--color-muted)]">
              A Coinbase login is part of the purchase; Coinbase’s card fee applies. A gift by card joins the principal without a patron mark. To hold
              a mark, give USDG from a wallet above.
            </p>
          </div>
        )}
      </Card>
    </Section>
  );
}

type Carried = { readonly requestId: Hex; readonly dollars: number | undefined };

function remember(endowment: string, carried: Carried): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(`${STORAGE}.${endowment.toLowerCase()}`, JSON.stringify(carried));
  } catch {
    // Storage that refuses costs the reader a reload's worth of tracking and nothing else.
  }
}

function forget(endowment: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(`${STORAGE}.${endowment.toLowerCase()}`);
  } catch {
    // As above.
  }
}

function recall(endowment: string): Carried | undefined {
  if (typeof window === 'undefined') return undefined;
  const asked = new URLSearchParams(window.location.search);
  const named = asked.get('relay');
  if (named !== null && /^0x[0-9a-fA-F]{64}$/.test(named)) return { requestId: named as Hex, dollars: undefined };
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE}.${endowment.toLowerCase()}`);
    if (raw === null) return undefined;
    const stored = JSON.parse(raw) as { requestId?: string; dollars?: number };
    if (typeof stored.requestId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(stored.requestId)) return undefined;
    return { requestId: stored.requestId as Hex, dollars: typeof stored.dollars === 'number' ? stored.dollars : undefined };
  } catch {
    return undefined;
  }
}
