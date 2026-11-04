import type { Workspace, MandateDraft } from '@/workspace/model';
import { newDraft } from '@/workspace/model';
import { readDraft } from '@/app/(app)/console/limits-form';
import { AssistantRefusal, parseProposal } from './actions';
import type { DraftProposal, DraftFields } from './actions';

export type DraftChange = { readonly field: string; readonly from: string; readonly to: string };
const FIELD_ORDER = ['name', 'perCall', 'daily', 'total', 'approvalMode', 'approvalAmount', 'validUntil'] as const;

/** The revision is local to this tab: it is never sent to a model or treated as a login credential. */
export function workspaceRevision(workspace: Workspace): string {
  return JSON.stringify(workspace);
}

/** Local proposals default to approving every payment, never to bypassing consent. */
function assistantNewDraft(): MandateDraft {
  const draft = newDraft();
  return { ...draft, limits: { ...draft.limits, approvalMode: 'every' } };
}

/** The existing Bursar form owns the underlying limit rules, not the model. */
function editDraft(draft: MandateDraft, fields: DraftFields): MandateDraft {
  if (fields.total !== undefined && draft.limits.longWindow !== 0) {
    throw new AssistantRefusal('window_change_refused', 'Converting a rolling second cap to a lifetime budget requires the manual Bursar editor.');
  }
  const next = {
    ...draft,
    name: fields.name ?? draft.name,
    limits: {
      ...draft.limits,
      ...(fields.perCall === undefined ? {} : { perCall: fields.perCall }),
      ...(fields.daily === undefined ? {} : { daily: fields.daily }),
      ...(fields.total === undefined ? {} : { monthly: fields.total, longWindow: 0 }),
      ...(fields.approvalMode === undefined ? {} : { approvalMode: fields.approvalMode }),
      ...(fields.approvalAmount === undefined ? {} : { approvalAmount: fields.approvalAmount }),
      ...(fields.validUntil === undefined ? {} : { validUntil: fields.validUntil }),
    },
    updatedAt: new Date().toISOString(),
  };
  const reading = readDraft(next.limits);
  // Incomplete drafts are allowed: all explicitly supplied fields have been shape-checked.
  // A complete but contradictory set of limits is not silently accepted.
  const allFilled = next.limits.perCall !== '' && next.limits.daily !== '' && next.limits.monthly !== ''
    && (next.limits.approvalMode !== 'above' || next.limits.approvalAmount !== '');
  if (allFilled && reading.problems.length > 0) {
    throw new AssistantRefusal('limits_refused', reading.problems.map((p) => p.problem).join(' '));
  }
  return next;
}

export function previewDraftChange(workspace: Workspace, unsafeProposal: unknown): readonly DraftChange[] {
  const proposal = parseProposal(unsafeProposal);
  const old = proposal.kind === 'draft.patch'
    ? workspace.drafts.find((draft) => draft.id === proposal.draftId)
    : undefined;
  if (proposal.kind === 'draft.patch' && !old) throw new AssistantRefusal('target_missing', 'This draft is no longer in the unlocked workspace.');
  if (proposal.kind === 'draft.patch' && old?.activated) {
    throw new AssistantRefusal('activated_draft', 'An activated draft must be edited through the existing Bursar controls.');
  }
  const before = old ?? assistantNewDraft();
  const after = editDraft(before, proposal.fields);
  return FIELD_ORDER.filter((field) => field in proposal.fields).map((field) => ({
    field,
    from: valueAt(before, field),
    to: valueAt(after, field),
  }));
}

function valueAt(draft: MandateDraft, key: keyof DraftFields): string {
  if (key === 'name') return draft.name;
  if (key === 'perCall') return draft.limits.perCall;
  if (key === 'daily') return draft.limits.daily;
  if (key === 'total') return draft.limits.monthly;
  if (key === 'approvalMode') return draft.limits.approvalMode;
  if (key === 'approvalAmount') return draft.limits.approvalAmount;
  return draft.limits.validUntil;
}

/** Called only inside WorkspaceActions.update after a human presses Apply. */
export function commitDraftProposal(workspace: Workspace, unsafeProposal: unknown, expectedRevision: string): Workspace {
  if (workspaceRevision(workspace) !== expectedRevision) {
    throw new AssistantRefusal('stale_context', 'The workspace changed. Review a fresh proposal before applying.');
  }
  const proposal: DraftProposal = parseProposal(unsafeProposal);
  if (proposal.kind === 'draft.create') {
    const draft = editDraft(assistantNewDraft(), proposal.fields);
    return { ...workspace, drafts: [...workspace.drafts, draft] };
  }
  const found = workspace.drafts.find((draft) => draft.id === proposal.draftId);
  if (!found) throw new AssistantRefusal('target_missing', 'The selected draft no longer exists.');
  if (found.activated) throw new AssistantRefusal('activated_draft', 'This draft is activated and cannot be patched by the assistant.');
  return {
    ...workspace,
    drafts: workspace.drafts.map((draft) => draft.id === proposal.draftId ? editDraft(draft, proposal.fields) : draft),
  };
}
