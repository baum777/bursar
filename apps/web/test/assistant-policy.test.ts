import { describe, expect, it } from 'vitest';

import { EMPTY_WORKSPACE, newDraft } from '@/workspace/model';
import type { Workspace } from '@/workspace/model';
import { assistantContext } from '@/assistant/context';
import { previewDraftChange, commitDraftProposal, workspaceRevision } from '@/assistant/policy';

const CREATE = { kind: 'draft.create', fields: { name: 'Research', perCall: '1', daily: '5', total: '25', approvalMode: 'every' } } as const;

describe('workspace changes are reviewed and applied only against the captured revision', () => {
  it('creates a complete local draft using Bursar limit semantics', () => {
    const revision = workspaceRevision(EMPTY_WORKSPACE);
    expect(previewDraftChange(EMPTY_WORKSPACE, CREATE)).toContainEqual({ field: 'total', from: '', to: '25' });
    const result = commitDraftProposal(EMPTY_WORKSPACE, CREATE, revision);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.limits).toMatchObject({
      perCall: '1', daily: '5', monthly: '25', longWindow: 0, approvalMode: 'every',
    });
    expect(result.drafts[0]?.activated).toBeNull();
  });
  it('refuses a stale edit rather than silently overwriting another change', () => {
    const revision = workspaceRevision(EMPTY_WORKSPACE);
    const updated: Workspace = { ...EMPTY_WORKSPACE, agents: [{ id: 'a', name: 'Other', address: 'x', notes: '' }] };
    expect(() => commitDraftProposal(updated, CREATE, revision)).toThrow('workspace changed');
  });
  it('rejects a contradictory complete budget ladder', () => {
    expect(() => previewDraftChange(EMPTY_WORKSPACE, { kind: 'draft.create', fields: {
      name: 'Bad', perCall: '10', daily: '5', total: '15', approvalMode: 'every',
    } })).toThrow('period cap');
  });
  it('refuses model patches to activated mandates and unknown draft IDs', () => {
    const draft = newDraft();
    const current: Workspace = { ...EMPTY_WORKSPACE, drafts: [{ ...draft, activated: { address: '0x0', hash: '0x1', at: new Date().toISOString() } }] };
    const proposal = { kind: 'draft.patch', draftId: draft.id, fields: { name: 'Changed' } };
    expect(() => previewDraftChange(current, proposal)).toThrow('activated');
    expect(() => commitDraftProposal(current, proposal, workspaceRevision(current))).toThrow('activated');
    expect(() => commitDraftProposal(EMPTY_WORKSPACE, proposal, workspaceRevision(EMPTY_WORKSPACE))).toThrow('no longer exists');
  });
  it('does not leak private mandate terms through the allowed model context', () => {
    const source = newDraft();
    const privateDraft = { ...source, notes: 'HIDDEN NOTES', privateTerms: { salt: 'HIDDEN SALT' } } as unknown as typeof source;
    const view = { status: 'unlocked', workspace: { ...EMPTY_WORKSPACE, drafts: [privateDraft] }, updatedAt: null } as const;
    const clean = assistantContext(view, { kind: 'workspace' });
    expect(JSON.stringify(clean)).not.toContain('HIDDEN');
    expect(clean.workspace.drafts[0]?.id).toBe(source.id);
  });
});
