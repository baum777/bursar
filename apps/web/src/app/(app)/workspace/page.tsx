import type { Metadata } from 'next';

import { shareMetadata } from '@/share';
import { WorkspaceView } from './workspace-view';

export const metadata: Metadata = shareMetadata('workspace', {
  title: 'Workspace · Bursar',
  description: 'Draft a mandate privately and check a payment against it before anything goes on chain.',
  path: '/workspace',
});

export default function WorkspacePage() {
  return <WorkspaceView />;
}
