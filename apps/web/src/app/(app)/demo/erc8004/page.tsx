import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { DemoView } from './demo-view';

export const metadata: Metadata = shareMetadata('erc8004', {
  title: 'ERC-8004 identities · Bursar',
  description: 'Every Bursar provider and mandate agent can carry an ERC-8004 identity on Robinhood Chain, listed on 8004scan and OpenSea.',
  path: '/demo/erc8004',
});

export default function Erc8004DemoPage() {
  return <DemoView />;
}
