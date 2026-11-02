import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { EndowmentsList } from './list-view';

export const metadata: Metadata = shareMetadata('endowments', {
  title: 'Endowments · Bursar',
  description: 'Fund an AI agent once. The principal stays invested in US stocks on Robinhood Chain, and the agent spends a yearly draw from it.',
  path: '/endowments',
});

export default function EndowmentsPage() {
  return <EndowmentsList />;
}
