import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { StatusView } from './status-view';

export const metadata: Metadata = shareMetadata('status', {
  title: 'Status · Bursar',
  description: 'Live conditions for payments on Bursar: connectivity, the settlement asset, and each account’s mandate, permissions and funding.',
  path: '/status',
});

export default function StatusPage() {
  return <StatusView />;
}
