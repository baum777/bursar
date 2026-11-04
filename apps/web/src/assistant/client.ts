import type { AssistantContext } from './context';
import type { ChatLine, AssistantEvent } from './provider';

/** SSE protocol is deliberately small and does not expose raw model/provider responses. */
export async function streamAssistant(input: {
  readonly messages: readonly ChatLine[];
  readonly context: AssistantContext;
  readonly accessToken: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: AssistantEvent) => void;
}): Promise<void> {
  const response = await fetch('/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bursar-assistant-token': input.accessToken },
    body: JSON.stringify({ messages: input.messages, context: input.context }),
    signal: input.signal,
    cache: 'no-store',
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : 'Assistant request failed (' + response.status + ').';
    throw new Error(message);
  }
  if (!response.body) throw new Error('Assistant returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let done = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true }).replace(/\r\n/gu, '\n');
      if (pending.length > 200_000) throw new Error('Assistant stream exceeded the response limit.');
      let cut = pending.indexOf('\n\n');
      while (cut >= 0) {
        const frame = pending.slice(0, cut);
        pending = pending.slice(cut + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
        if (data) {
          const parsed: unknown = JSON.parse(data);
          if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) throw new Error('Assistant stream event is invalid.');
          const event = parsed as AssistantEvent;
          if (event.type === 'error') throw new Error(event.message);
          if (event.type === 'done') done = true;
          input.onEvent(event);
        }
        cut = pending.indexOf('\n\n');
      }
    }
    if (!done) throw new Error('Assistant stream ended without completion.');
  } finally {
    reader.releaseLock();
  }
}
