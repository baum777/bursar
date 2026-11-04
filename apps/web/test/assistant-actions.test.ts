import { describe, expect, it } from 'vitest';

import { parseProposal, proposalFromTool, AssistantRefusal } from '@/assistant/actions';
import { decodeModelDelta, finishToolCalls, modelMessages } from '@/assistant/provider';
import { sanitizeContext } from '@/assistant/context';

describe('model output cannot extend its authority', () => {
  it('accepts one explicitly typed local create proposal', () => {
    const proposal = parseProposal({
      kind: 'draft.create', fields: { name: 'Research', perCall: '1', daily: '5', total: '25', approvalMode: 'every' },
    });
    expect(proposal.kind).toBe('draft.create');
  });
  it('rejects unknown actions, keys, weak approval changes and malformed amounts', () => {
    expect(() => parseProposal({ kind: 'wallet.send', fields: { amount: '10' } })).toThrow(AssistantRefusal);
    expect(() => parseProposal({ kind: 'draft.create', fields: { name: 'Test', privateTerms: 'secret' } })).toThrow('cannot edit');
    expect(() => parseProposal({ kind: 'draft.create', fields: { approvalMode: 'never' } })).toThrow('cannot disable');
    for (const amount of ['0', '-1', '1.1234567', 'abc', '1e20', '0.0000000']) {
      expect(() => parseProposal({ kind: 'draft.create', fields: { daily: amount } }), amount).toThrow(AssistantRefusal);
    }
    expect(() => parseProposal({ kind: 'draft.patch', fields: { name: 'No ID' } })).toThrow('draft ID');
    expect(() => parseProposal({ kind: 'draft.create', draftId: 'target', fields: { name: 'No' } })).toThrow('Create cannot');
  });
  it('accepts only known tool names with one bounded proposal', () => {
    expect(proposalFromTool('propose_draft_create', '{"fields":{"name":"Demo"}}')).toEqual({ kind: 'draft.create', fields: { name: 'Demo' } });
    expect(() => proposalFromTool('send_transaction', '{}')).toThrow('does not offer');
    expect(() => proposalFromTool('propose_draft_create', '{')).toThrow('invalid JSON');
    expect(() => finishToolCalls(new Map([[0, { name: 'propose_draft_create', args: '{"fields":{"name":"A"}}' }], [1, { name: 'propose_draft_create', args: '{"fields":{"name":"B"}}' }]]))).toThrow('one operation');
  });
});

describe('model protocol and context boundaries', () => {
  it('reassembles streamed tool-call fragments without executing them', () => {
    const first = decodeModelDelta({ choices: [{ delta: { content: 'Planning', tool_calls: [{ index: 0, function: { name: 'propose_draft_create', arguments: '{"fields":' } }] } }] });
    const second = decodeModelDelta({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"name":"Research"}}' } }] } }] });
    expect(first.text).toBe('Planning');
    expect(finishToolCalls(new Map([[0, {
      name: first.calls![0]!.name!,
      args: first.calls![0]!.args! + second.calls![0]!.args!,
    }]]))).toEqual({ kind: 'draft.create', fields: { name: 'Research' } });
  });
  it('removes any client-supplied private fields before they reach the model', () => {
    const context = sanitizeContext({
      surface: { kind: 'workspace', privateKey: 'LEAK' },
      workspace: {
        status: 'unlocked', passphrase: 'LEAK',
        drafts: [{ id: 'one', name: 'Work', perCall: '1', daily: '2', total: '3', approvalMode: 'every', privateTerms: { salt: 'LEAK' }, notes: 'LEAK' }],
      },
    });
    const text = JSON.stringify(modelMessages([{ role: 'user', content: 'Help' }], context));
    expect(text).not.toContain('LEAK');
    expect(text).toContain('Work');
    expect(context.workspace.drafts).toHaveLength(1);
  });
  it('refuses unbounded context arrays and malformed addresses', () => {
    expect(() => sanitizeContext({ surface: { kind: 'mandate', address: '0x123' }, workspace: { status: 'locked', drafts: [] } })).toThrow('surface');
    expect(() => sanitizeContext({ surface: { kind: 'workspace' }, workspace: { status: 'unlocked', drafts: Array(25).fill({}) } })).toThrow('summary');
  });
});
