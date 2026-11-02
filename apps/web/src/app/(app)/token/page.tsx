import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { BursarTokenView } from './bursar-token';

export const metadata: Metadata = shareMetadata('token', {
  title: 'Token · Bursar',
  description: '$BURSAR on Robinhood Chain: the contract address and where to trade it.',
  path: '/token',
});

export default function TokenPage() {
  return <BursarTokenView />;
}
