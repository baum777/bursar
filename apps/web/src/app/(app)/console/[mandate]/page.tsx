import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { OverviewView } from './overview-view';

export const metadata: Metadata = shareMetadata('console', {
  title: 'Mandate · Bursar',
  description: 'See what this mandate can spend and manage how it pays.',
});

export default function MandatePage() {
  return <OverviewView assistantEnabled={process.env['BURSAR_ASSISTANT_ENABLED'] === 'true'} />;
}
