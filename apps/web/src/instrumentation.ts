/**
 * Runs once when the server starts. The stats page reads its figures from a scan of every Bursar
 * contract, which takes seconds, so the first scan starts here rather than on the first visit.
 *
 * The runtime check wraps the import as a plain `if` because that is the shape the bundler drops
 * from the edge build, which cannot load @bursar/core.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.NEXT_PHASE === 'phase-production-build') return;
    const { loadStats } = await import('./app/(app)/stats/read');
    void loadStats().catch(() => undefined);
  }
}
