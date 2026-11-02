import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { OpsView } from './ops-view';

export const metadata: Metadata = shareMetadata('operations', {
  title: 'Operations · Bursar',
  description:
    'Sweep settlement fees to the treasury, rotate the treasury in two steps, and propose the staking rebate tiers and the buyback price ceiling.',
  path: '/ops',
});

export default function OpsPage() {
  return <OpsView />;
}
