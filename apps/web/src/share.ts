import type { Metadata } from 'next';

export const APP_ORIGIN = 'https://app.bursar.world';

/**
 * The 1200x630 card each page shows when its link is shared, in bursar.world's own design. The
 * images are rendered from this list into public/og by `pnpm --filter @bursar/web og`, so a new card
 * or a changed line here needs that run before it ships.
 */
export const SHARE_CARDS = {
  app: { eyebrow: 'Bursar app', headline: 'Budgets and endowments for AI agents.' },
  stats: { eyebrow: 'Stats', headline: 'What agents have paid through Bursar.' },
  console: { eyebrow: 'Console', headline: 'A budget your agent cannot exceed.' },
  'console-new': { eyebrow: 'Create a mandate', headline: 'Set the limits before your agent spends.' },
  private: { eyebrow: 'Private mandates', headline: 'Manage the private mandates you own.' },
  shielded: { eyebrow: 'Shielded funds', headline: 'Pay providers from a shared USDG pool.' },
  endowments: { eyebrow: 'Endowments', headline: 'Fund an AI agent once.' },
  'endowments-new': { eyebrow: 'Endow an agent', headline: 'The principal stays invested.' },
  providers: { eyebrow: 'Providers', headline: 'Get paid by agents through escrow.' },
  resolvers: { eyebrow: 'Resolvers', headline: 'Rule on contested payments.' },
  token: { eyebrow: 'Token', headline: '$BURSAR on Robinhood Chain.' },
  governance: { eyebrow: 'Governance', headline: 'Every settings change waits in public.' },
  status: { eyebrow: 'Status', headline: 'Live conditions for payments.' },
  developers: { eyebrow: 'Developers', headline: 'Let your agent pay with Bursar.' },
  'ruling-policy': { eyebrow: 'Ruling policy', headline: 'How a disputed payment is ruled on.' },
  haircuts: { eyebrow: 'Collateral', headline: 'Haircuts, read from Robinhood Chain.' },
  workspace: { eyebrow: 'Workspace', headline: 'Draft a mandate before it goes on chain.' },
  operations: { eyebrow: 'Operations', headline: 'Treasury and fee operations.' },
  assistants: { eyebrow: 'Assistants', headline: 'Give your assistant a budget.' },
  erc8004: { eyebrow: 'ERC-8004', headline: 'Onchain identities for agents and providers.' },
  'relay-funding': { eyebrow: 'Funding', headline: 'Fund a mandate from Base, Arc or Solana.' },
  'safe-budgets': { eyebrow: 'Safe', headline: 'Agent budgets from a Safe.' },
} as const satisfies Record<string, { readonly eyebrow: string; readonly headline: string }>;

export type ShareCard = keyof typeof SHARE_CARDS;

/**
 * A page's title and description, and the same pair for link previews with its card. Previews do
 * not fall back to the page title, so a page that sets only `title` would share as the bare site.
 */
export function shareMetadata(card: ShareCard, page: { title: string; description: string; path?: string }): Metadata {
  const { title, description, path } = page;
  const image = { url: `/og/${card}.jpg`, width: 1200, height: 630, alt: title };
  return {
    title,
    description,
    ...(path === undefined ? {} : { alternates: { canonical: path } }),
    openGraph: { type: 'website', siteName: 'Bursar', locale: 'en_US', title, description, images: [image], ...(path === undefined ? {} : { url: path }) },
    twitter: { card: 'summary_large_image', site: '@UseBursar', title, description, images: [image] },
  };
}
