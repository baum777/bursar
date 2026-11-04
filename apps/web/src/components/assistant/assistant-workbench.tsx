'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '@/components/button';
import { assistantContext } from '@/assistant/context';
import type { AssistantSurface } from '@/assistant/context';
import { streamAssistant } from '@/assistant/client';
import { previewDraftChange, commitDraftProposal, workspaceRevision } from '@/assistant/policy';
import type { DraftChange } from '@/assistant/policy';
import type { DraftProposal } from '@/assistant/actions';
import type { ChatLine } from '@/assistant/provider';
import { useWorkspace } from '@/workspace/context';

type Pending = { readonly proposal: DraftProposal; readonly revision: string };
type EventLine = { readonly status: 'proposed' | 'applied' | 'refused'; readonly text: string };

/**
 * This is a local setup assistant, not the on-chain mandate agent or the existing MCP connector.
 * Model messages can suggest a typed draft patch. Only a user click reaches WorkspaceActions.update.
 */
export function AssistantWorkbench({ surface }: { readonly surface: AssistantSurface }) {
  const { view, actions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [shareDrafts, setShareDrafts] = useState(false);
  const [input, setInput] = useState('');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [history, setHistory] = useState<EventLine[]>([]);
  const [lastDraft, setLastDraft] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState('');
  const controller = useRef<AbortController | null>(null);
  const scrollEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (open) scrollEnd.current?.scrollIntoView({ block: 'end' }); }, [lines, pending, open]);

  const targetId = pending?.proposal.kind === 'draft.patch' ? pending.proposal.draftId : undefined;
  const context = assistantContext(view, surface);
  const sharedContext = shareDrafts ? context : { ...context, workspace: { ...context.workspace, drafts: [] } };
  let changes: readonly DraftChange[] | undefined;
  let reviewError = '';
  if (pending !== null && view.status === 'unlocked') {
    try {
      if (workspaceRevision(view.workspace) !== pending.revision) throw new Error('The workspace changed after this proposal was created.');
      changes = previewDraftChange(view.workspace, pending.proposal);
    } catch (error) {
      reviewError = error instanceof Error ? error.message : 'The proposed change is no longer valid.';
    }
  }

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    const question = input.trim();
    if (!question || busy) return;
    const conversation: ChatLine[] = [...lines.slice(-14), { role: 'user', content: question.slice(0, 3_000) }];
    const revision = view.status === 'unlocked' ? workspaceRevision(view.workspace) : '';
    setInput('');
    setPending(null);
    setFailure('');
    setBusy(true);
    setLines([...conversation, { role: 'assistant', content: '' }]);
    const next = new AbortController();
    controller.current = next;
    let responseText = '';
    try {
      await streamAssistant({
        messages: conversation,
        context: sharedContext,
        accessToken: accessToken.trim(),
        signal: next.signal,
        onEvent: (evt) => {
          if (evt.type === 'delta') {
            responseText += evt.text;
            setLines((current) => current.map((line, i) => i === current.length - 1 ? { role: 'assistant' as const, content: responseText } : line));
          }
          if (evt.type === 'proposal') {
            setPending({ proposal: evt.proposal, revision });
            setHistory((old) => [...old.slice(-9), { status: 'proposed' as const, text: 'Draft change proposed for review.' }]);
          }
        },
      });
      if (!responseText) setLines((current) => current.map((line, i) => i === current.length - 1 ? { role: 'assistant' as const, content: 'The draft proposal is ready for review.' } : line));
    } catch (error) {
      if (!next.signal.aborted) {
        setFailure(error instanceof Error ? error.message : 'The assistant request failed.');
        setLines((current) => current.filter((line, i) => i !== current.length - 1 || line.role !== 'assistant' || line.content !== ''));
      }
    } finally {
      if (controller.current === next) controller.current = null;
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (!pending || applying || view.status !== 'unlocked' || changes === undefined || reviewError) return;
    setApplying(true);
    setFailure('');
    let createdId: string | undefined;
    try {
      await actions.update((current) => {
        const changed = commitDraftProposal(current, pending.proposal, pending.revision);
        if (pending.proposal.kind === 'draft.create') createdId = changed.drafts.at(-1)?.id;
        return changed;
      });
      setLastDraft(createdId ?? (pending.proposal.kind === 'draft.patch' ? pending.proposal.draftId : undefined));
      setPending(null);
      setHistory((old) => [...old.slice(-9), { status: 'applied' as const, text: 'Local draft saved and verified by the workspace update.' }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The workspace refused the operation.';
      setFailure(message);
      setHistory((old) => [...old.slice(-9), { status: 'refused' as const, text: message }]);
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <div className="fixed bottom-4 right-4 z-40">
        <Button tone="primary" size="sm" onClick={() => setOpen(true)} aria-label="Open Bursar setup assistant">
          Setup assistant
        </Button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50" role="presentation">
          <button type="button" aria-label="Close assistant" onClick={() => setOpen(false)}
            className="absolute inset-0 bg-[color:var(--color-scrim)]" />
          <aside role="dialog" aria-modal="true" aria-label="Bursar setup assistant"
            className="absolute inset-y-0 right-0 flex w-full max-w-[34rem] flex-col border-l border-[color:var(--color-line)] bg-[color:var(--color-paper)] shadow-xl">
            <header className="flex items-center justify-between border-b border-[color:var(--color-line)] px-5 py-4">
              <div>
                <h2 className="text-lg font-medium tracking-[-0.02em]">Setup assistant</h2>
                <p className="text-note text-[color:var(--color-muted)]">Plan and prepare a mandate. No autonomous on-chain writes.</p>
              </div>
              <Button size="sm" onClick={() => setOpen(false)} aria-label="Close assistant panel">Close</Button>
            </header>
            <div className="border-b border-[color:var(--color-line)] bg-[color:var(--color-raised)] px-5 py-3">
              <label className="block space-y-1">
                <span className="text-label uppercase tracking-wide text-[color:var(--color-muted)]">Assistant access token</span>
                <input type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="Operator token (not a wallet key)"
                  className="h-10 w-full border border-[color:var(--color-line)] bg-surface px-3 font-mono text-note focus:outline focus:outline-2 focus:outline-[color:var(--color-ring)]" />
              </label>
              <label className="mt-3 flex items-start gap-2 text-note text-[color:var(--color-muted)]">
                <input type="checkbox" checked={shareDrafts} onChange={(e) => setShareDrafts(e.target.checked)}
                  className="mt-0.5 accent-[color:var(--color-primary)]" />
                Share a limited summary of my draft names and spending limits with the model.
              </label>
              <p className="mt-2 text-note text-[color:var(--color-muted)]">
                Workspace: {view.status === 'unlocked' ? 'unlocked' : 'locked or unavailable'}.
                Private terms, salts, notes and keys are never included.
              </p>
            </div>

            <div role="log" aria-live="polite" aria-relevant="additions text" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
              {lines.length === 0 && (
                <div className="space-y-3 text-sm">
                  <p className="font-medium">What would you like to set up?</p>
                  <p className="text-[color:var(--color-muted)]">Describe a budget, approval rule or mandate idea. I can prepare local drafts and explain the existing signing steps.</p>
                  <p className="text-detail text-[color:var(--color-muted)]">Example: Create a research agent draft with 1 USDG per payment, 5 USDG per day and 25 USDG total. Require approval for every payment.</p>
                </div>
              )}
              {lines.map((line, index) => (
                <div key={index} className={line.role === 'user' ? 'ml-8 border border-[color:var(--color-line)] bg-surface p-3' : 'mr-5'}>
                  <p className="mb-1 font-mono text-label uppercase text-[color:var(--color-muted)]">{line.role === 'user' ? 'You' : 'Assistant'}</p>
                  <p className="whitespace-pre-wrap break-words text-sm">{line.content || (busy ? '…' : '')}</p>
                </div>
              ))}
              {pending && (
                <section aria-label="Review model proposal" className="border border-[color:var(--color-line-strong)] bg-surface p-4">
                  <h3 className="text-sm font-semibold">Review draft {pending.proposal.kind === 'draft.create' ? 'creation' : 'update'}</h3>
                  {targetId && <p className="mt-1 break-all font-mono text-note">Target: {view.status === 'unlocked' ? (view.workspace.drafts.find((item) => item.id === targetId)?.name || targetId) : targetId}</p>}
                  <p className="mt-1 text-note text-[color:var(--color-muted)]">This is a model suggestion, not an executed action.</p>
                  {view.status !== 'unlocked' ? (
                    <p className="mt-3 text-detail text-[color:var(--color-state-blocked)]">Unlock or create your Workspace to apply changes.</p>
                  ) : reviewError ? (
                    <p role="alert" className="mt-3 text-detail text-[color:var(--color-state-blocked)]">{reviewError}</p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {changes?.map((change) => (
                        <div key={change.field} className="border-t border-[color:var(--color-line)] pt-2">
                          <p className="font-mono text-label uppercase text-[color:var(--color-muted)]">{change.field}</p>
                          <p className="break-all text-note"><span className="text-[color:var(--color-muted)]">{change.from || '(unset)'}</span> → {change.to || '(unset)'}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button tone="primary" size="sm" disabled={!changes || !!reviewError || applying || view.status !== 'unlocked'}
                      onClick={() => void apply()}>{applying ? 'Saving' : 'Apply to local workspace'}</Button>
                    <Button size="sm" onClick={() => setPending(null)}>Dismiss</Button>
                  </div>
                </section>
              )}
              {lastDraft && (
                <div className="border border-[color:var(--color-line)] bg-surface p-3 text-sm">
                  <p className="font-medium">Draft saved locally. No transaction sent.</p>
                  <Link href={'/workspace/drafts/' + lastDraft} onClick={() => setOpen(false)}
                    className="mt-2 inline-block text-detail underline underline-offset-2">Open draft</Link>
                  <Link href={'/console/new?draft=' + encodeURIComponent(lastDraft)} onClick={() => setOpen(false)}
                    className="ml-4 inline-block text-detail underline underline-offset-2">Review on-chain setup</Link>
                </div>
              )}
              {history.length > 0 && (
                <details className="border-t border-[color:var(--color-line)] pt-3">
                  <summary className="cursor-pointer font-mono text-label uppercase text-[color:var(--color-muted)]">Execution events ({history.length})</summary>
                  <ol className="mt-2 space-y-2 text-note">
                    {history.map((entry, i) => <li key={i}><strong>{entry.status}</strong> · {entry.text}</li>)}
                  </ol>
                </details>
              )}
              {failure && <p role="alert" className="border border-[color:var(--color-state-blocked)] p-3 text-sm text-[color:var(--color-state-blocked)]">{failure}</p>}
              <div ref={scrollEnd} />
            </div>
            <form onSubmit={(e) => void send(e)} className="border-t border-[color:var(--color-line)] bg-surface p-4">
              <label htmlFor="assistant-prompt" className="block font-mono text-label uppercase text-[color:var(--color-muted)]">Your message</label>
              <textarea id="assistant-prompt" value={input} onChange={(e) => setInput(e.target.value)} rows={3}
                maxLength={3000} placeholder="Describe your mandate setup…"
                className="mt-2 w-full resize-none border border-[color:var(--color-line)] bg-surface p-3 text-sm focus:outline focus:outline-2 focus:outline-[color:var(--color-ring)]" />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-note text-[color:var(--color-muted)]">Draft-only execution · explicit review</span>
                <div className="flex gap-2">
                  {busy && <Button size="sm" onClick={() => controller.current?.abort()}>Stop</Button>}
                  <Button tone="primary" size="sm" type="submit" disabled={busy || !input.trim() || accessToken.length < 24}>Send</Button>
                </div>
              </div>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
