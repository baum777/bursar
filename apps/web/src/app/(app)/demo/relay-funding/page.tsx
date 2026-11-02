import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { RelayFundingDemo } from './demo';

export const metadata: Metadata = shareMetadata('relay-funding', {
  title: 'Fund a mandate from Base, Arc or Solana · Bursar',
  description: 'Send USDC from Base, Arc or Solana and USDG lands in a Bursar mandate on Robinhood Chain. Relay carries the transfer.',
  path: '/demo/relay-funding',
});

export default function RelayFundingDemoPage() {
  return <RelayFundingDemo />;
}
