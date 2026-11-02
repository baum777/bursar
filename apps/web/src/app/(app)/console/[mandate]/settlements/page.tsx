import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { SettlementsView } from './settlements-view';

export const metadata: Metadata = shareMetadata('console', {
  title: 'Settlements · Bursar',
  description: 'Every payment this mandate has made and where each one stands.',
});

export default function SettlementsPage() {
  return <SettlementsView />;
}
