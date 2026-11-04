/**
 * The model may propose only these local, reversible draft edits. A proposal is never
 * an authority to write: the browser has to review it against its live workspace.
 */
export type DraftFields = {
  readonly name?: string;
  readonly perCall?: string;
  readonly daily?: string;
  readonly total?: string;
  readonly approvalMode?: 'every' | 'above';
  readonly approvalAmount?: string;
  readonly validUntil?: string;
};

export type DraftProposal =
  | { readonly kind: 'draft.create'; readonly fields: DraftFields }
  | { readonly kind: 'draft.patch'; readonly draftId: string; readonly fields: DraftFields };

const FIELDS = ['name', 'perCall', 'daily', 'total', 'approvalMode', 'approvalAmount', 'validUntil'] as const;
const MONEY = /^\d{1,12}(?:[.,]\d{1,6})?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export class AssistantRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AssistantRefusal';
  }
}

export function parseProposal(value: unknown): DraftProposal {
  if (!record(value)) throw new AssistantRefusal('bad_proposal', 'The model did not return a proposal object.');
  if (!only(value, ['kind', 'draftId', 'fields'])) throw new AssistantRefusal('unknown_action_field', 'The proposal has unsupported fields.');
  if (value.kind !== 'draft.create' && value.kind !== 'draft.patch') {
    throw new AssistantRefusal('unknown_action', 'This version only prepares workspace drafts.');
  }
  if (!record(value.fields) || !only(value.fields, FIELDS)) {
    throw new AssistantRefusal('unsupported_field', 'The proposal contains a field the assistant cannot edit.');
  }
  if (Object.keys(value.fields).length === 0) throw new AssistantRefusal('empty_patch', 'Nothing was proposed.');
  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value.fields)) {
    if (typeof raw !== 'string' || raw.length > 200) throw new AssistantRefusal('invalid_field', 'Invalid value for ' + key + '.');
    const normalized = raw.trim();
    if (key === 'name' && (normalized.length < 1 || normalized.length > 80)) {
      throw new AssistantRefusal('invalid_name', 'A draft name needs 1 to 80 characters.');
    }
    if (['perCall', 'daily', 'total', 'approvalAmount'].includes(key) && (!MONEY.test(normalized) || !/[1-9]/u.test(normalized))) {
      throw new AssistantRefusal('invalid_amount', key + ' must be a positive USDG amount with at most six decimals.');
    }
    if (key === 'validUntil' && normalized !== '' && (!DATE.test(normalized) || Number.isNaN(Date.parse(normalized + 'T00:00:00Z')))) {
      throw new AssistantRefusal('invalid_date', 'The expiry must be a valid ISO date.');
    }
    if (key === 'approvalMode' && normalized !== 'every' && normalized !== 'above') {
      throw new AssistantRefusal('unsupported_approval', 'The assistant cannot disable payment approvals.');
    }
    fields[key] = normalized;
  }
  if (value.kind === 'draft.create') {
    if ('draftId' in value) throw new AssistantRefusal('invalid_target', 'Create cannot name a draft to overwrite.');
    return { kind: 'draft.create', fields: fields as DraftFields };
  }
  if (typeof value.draftId !== 'string' || value.draftId.length > 100 || value.draftId.length === 0) {
    throw new AssistantRefusal('invalid_target', 'Patch requires an existing draft ID.');
  }
  return { kind: 'draft.patch', draftId: value.draftId, fields: fields as DraftFields };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const fieldProperties = {
  name: { type: 'string', description: 'Human-readable draft name, 1 to 80 characters.' },
  perCall: { type: 'string', description: 'Maximum USDG amount per payment; decimal string.' },
  daily: { type: 'string', description: 'Rolling daily USDG budget; decimal string.' },
  total: { type: 'string', description: 'Lifetime USDG budget, not a monthly limit; decimal string.' },
  approvalMode: { type: 'string', enum: ['every', 'above'], description: 'Every payment needs approval, or approvals start at approvalAmount. Never choose no approvals.' },
  approvalAmount: { type: 'string', description: 'USDG threshold when approvalMode is above.' },
  validUntil: { type: 'string', description: 'Optional expiry date YYYY-MM-DD.' },
} as const;

export const ASSISTANT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'propose_draft_create',
      description: 'Propose a NEW local draft for review. Does not create an on-chain mandate or execute a transaction.',
      parameters: { type: 'object', properties: { fields: { type: 'object', properties: fieldProperties, additionalProperties: false } }, required: ['fields'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_draft_patch',
      description: 'Propose edits to an existing unlocked workspace draft. The user must approve the exact change.',
      parameters: {
        type: 'object',
        properties: { draftId: { type: 'string' }, fields: { type: 'object', properties: fieldProperties, additionalProperties: false } },
        required: ['draftId', 'fields'], additionalProperties: false,
      },
    },
  },
] as const;

export function proposalFromTool(name: string, argumentsJson: string): DraftProposal {
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsJson); }
  catch { throw new AssistantRefusal('invalid_tool_arguments', 'The model returned invalid JSON.'); }
  if (!record(parsed)) throw new AssistantRefusal('invalid_tool_arguments', 'The tool arguments must be an object.');
  if (name === 'propose_draft_create') {
    if (!only(parsed, ['fields'])) throw new AssistantRefusal('invalid_tool_arguments', 'Unexpected create arguments.');
    return parseProposal({ kind: 'draft.create', fields: parsed.fields });
  }
  if (name === 'propose_draft_patch') {
    if (!only(parsed, ['draftId', 'fields'])) throw new AssistantRefusal('invalid_tool_arguments', 'Unexpected patch arguments.');
    return parseProposal({ kind: 'draft.patch', draftId: parsed.draftId, fields: parsed.fields });
  }
  throw new AssistantRefusal('unknown_tool', 'The model called a tool this assistant does not offer.');
}
