import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { ExceptionsView } from './exceptions-view';

export const metadata: Metadata = shareMetadata('console', {
  title: 'Exceptions · Bursar',
  description: 'Payments that were refused, returned or contested, and why.',
});

export default function ExceptionsPage() {
  return <ExceptionsView />;
}
