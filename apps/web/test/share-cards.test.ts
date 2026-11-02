import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SHARE_CARDS, shareMetadata } from '@/share';

const WEB = join(__dirname, '..');
const PAGES = join(WEB, 'src/app/(app)');

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name === 'page.tsx' ? [path] : [];
  });
}

describe('share cards', () => {
  it('has a rendered image for every card', () => {
    for (const card of Object.keys(SHARE_CARDS)) {
      expect(existsSync(join(WEB, 'public/og', `${card}.jpg`)), `public/og/${card}.jpg`).toBe(true);
    }
  });

  it('gives a page its own title, description and card in link previews', () => {
    const metadata = shareMetadata('stats', { title: 'Stats · Bursar', description: 'What agents have paid.', path: '/stats' });
    expect(metadata.openGraph).toMatchObject({
      title: 'Stats · Bursar',
      description: 'What agents have paid.',
      url: '/stats',
      images: [{ url: '/og/stats.jpg', width: 1200, height: 630 }],
    });
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image', title: 'Stats · Bursar', images: [{ url: '/og/stats.jpg' }] });
    expect(metadata.alternates).toEqual({ canonical: '/stats' });
  });

  it('is set on every page that names a title', () => {
    for (const page of pages(PAGES)) {
      const source = readFileSync(page, 'utf8');
      if (!/export (const metadata|async function generateMetadata)/.test(source)) continue;
      expect(source, page.slice(PAGES.length)).toMatch(/shareMetadata\('[\w-]+'/);
    }
  });
});
