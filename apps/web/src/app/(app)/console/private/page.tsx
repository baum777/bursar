import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { PrivateOwnersView } from './private-owners-view';

export const metadata: Metadata = shareMetadata('private', {
  title: 'Private mandates · Bursar',
  description: 'Find and manage the private mandates your wallet owns.',
  path: '/console/private',
});

export default function PrivateOwnersPage() {
  return <PrivateOwnersView />;
}
