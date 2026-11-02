import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { ResolverView } from './resolver-view';

export const metadata: Metadata = shareMetadata('resolvers', {
  title: 'Ruling on disputes · Bursar',
  description:
    'Rule on contested payments. Bonded resolvers seal a score, reveal it, and the median sets how much goes back to the payer.',
  path: '/resolvers',
});

export default function ResolversPage() {
  return <ResolverView />;
}
