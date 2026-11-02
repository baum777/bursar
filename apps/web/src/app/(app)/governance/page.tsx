import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { GovernanceView } from './governance-view';

export const metadata: Metadata = shareMetadata('governance', {
  title: 'Governance · Bursar',
  description:
    'Proposed changes to Bursar settings, who has approved each one, and when each can run. Every change needs two of three signatures and a fixed delay. A guardian key can pause, and only pause.',
  path: '/governance',
});

export default function GovernancePage() {
  return <GovernanceView />;
}
