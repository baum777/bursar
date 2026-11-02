import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { ProviderView } from './provider-view';

export const metadata: Metadata = shareMetadata('providers', {
  title: 'Getting paid · Bursar',
  description:
    'Get paid by agents through escrow. List your address with a stake, deliver the work, and grow the size of job a payer can open.',
  path: '/providers',
});

export default function ProvidersPage() {
  return <ProviderView />;
}
