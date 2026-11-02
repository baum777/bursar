import type { Metadata } from 'next';
import { Suspense } from 'react';

import { shareMetadata } from '@/share';
import { ShieldedView } from './shielded-view';

export const metadata: Metadata = shareMetadata('shielded', {
  title: 'Shielded funds · Bursar',
  description: 'Fund mandates and pay providers from a shared USDG pool instead of straight from your wallet.',
  path: '/console/shielded',
});

export default function ShieldedPage() {
  return (
    <Suspense>
      <ShieldedView />
    </Suspense>
  );
}
