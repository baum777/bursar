import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { DraftView } from './draft-view';

export const metadata: Metadata = shareMetadata('workspace', {
  title: 'Draft · Workspace · Bursar',
  description: 'Edit a mandate draft and check a payment against it before you create the mandate.',
});

export default async function DraftPage({ params }: { readonly params: Promise<{ readonly draft: string }> }) {
  const { draft } = await params;
  return <DraftView draftId={draft} />;
}
