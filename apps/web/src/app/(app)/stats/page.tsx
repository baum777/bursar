import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { loadStats } from './read';
import { StatsView } from './stats-view';

export const metadata: Metadata = shareMetadata('stats', {
  title: 'Stats · Bursar',
  description: 'What AI agents have paid through Bursar on Robinhood Chain: payments settled, USDG in escrow and in mandates, and the providers paid.',
  path: '/stats',
});

export default async function StatsPage() {
  return <StatsView stats={await loadStats()} />;
}
