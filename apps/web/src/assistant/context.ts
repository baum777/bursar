import type { WorkspaceView } from '@/workspace/context';

export type AssistantSurface =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'mandate'; readonly address: string; readonly paused?: boolean; readonly revoked?: boolean; readonly perCallMicros?: string; readonly dailyMicros?: string };

export type AssistantContext = {
  readonly surface: AssistantSurface;
  readonly workspace: {
    readonly status: 'unlocked' | 'locked' | 'none';
    readonly drafts: readonly {
      readonly id: string;
      readonly name: string;
      readonly perCall: string;
      readonly daily: string;
      readonly total: string;
      readonly approvalMode: string;
    }[];
  };
};

/** By construction no notes, privateTerms, salts, keys or passphrases reach the model. */
export function assistantContext(view: WorkspaceView, surface: AssistantSurface): AssistantContext {
  if (view.status !== 'unlocked') {
    return { surface, workspace: { status: view.status === 'none' ? 'none' : 'locked', drafts: [] } };
  }
  return {
    surface,
    workspace: {
      status: 'unlocked',
      drafts: view.workspace.drafts.slice(0, 20).map((draft) => ({
        id: draft.id,
        name: draft.name.slice(0, 80),
        perCall: draft.limits.perCall,
        daily: draft.limits.daily,
        total: draft.limits.monthly,
        approvalMode: draft.limits.approvalMode,
      })),
    },
  };
}

/** The server also strips arbitrary fields from a forged or malformed browser payload. */
export function sanitizeContext(value: unknown): AssistantContext {
  if (!value || typeof value !== 'object') throw new Error('Invalid assistant context.');
  const raw = value as { surface?: unknown; workspace?: unknown };
  if (!raw.surface || typeof raw.surface !== 'object' || !raw.workspace || typeof raw.workspace !== 'object') throw new Error('Invalid context shape.');
  const surface = raw.surface as Record<string, unknown>;
  const ws = raw.workspace as Record<string, unknown>;
  let cleanSurface: AssistantSurface;
  if (surface.kind === 'workspace') cleanSurface = { kind: 'workspace' };
  else if (surface.kind === 'mandate' && typeof surface.address === 'string' && /^0x[0-9a-fA-F]{40}$/u.test(surface.address)) {
    cleanSurface = {
      kind: 'mandate', address: surface.address,
      ...(typeof surface.paused === 'boolean' ? { paused: surface.paused } : {}),
      ...(typeof surface.revoked === 'boolean' ? { revoked: surface.revoked } : {}),
      ...(typeof surface.perCallMicros === 'string' && /^\d{1,42}$/u.test(surface.perCallMicros) ? { perCallMicros: surface.perCallMicros } : {}),
      ...(typeof surface.dailyMicros === 'string' && /^\d{1,42}$/u.test(surface.dailyMicros) ? { dailyMicros: surface.dailyMicros } : {}),
    };
  } else throw new Error('Invalid assistant surface.');
  if (ws.status !== 'unlocked' && ws.status !== 'locked' && ws.status !== 'none') throw new Error('Invalid workspace status.');
  if (!Array.isArray(ws.drafts) || ws.drafts.length > 20) throw new Error('Invalid draft summary.');
  const drafts = ws.status !== 'unlocked' ? [] : ws.drafts.map((draft: unknown) => {
    if (!draft || typeof draft !== 'object') throw new Error('Invalid draft summary.');
    const d = draft as Record<string, unknown>;
    const get = (key: string, max: number): string => {
      if (typeof d[key] !== 'string' || (d[key] as string).length > max) throw new Error('Invalid draft field.');
      return d[key] as string;
    };
    return {
      id: get('id', 100), name: get('name', 80), perCall: get('perCall', 32),
      daily: get('daily', 32), total: get('total', 32), approvalMode: get('approvalMode', 12),
    };
  });
  return { surface: cleanSurface, workspace: { status: ws.status, drafts } };
}
