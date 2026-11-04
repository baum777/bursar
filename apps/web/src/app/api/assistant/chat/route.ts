import { timingSafeEqual } from 'node:crypto';
import { AssistantRefusal } from '@/assistant/actions';
import { sanitizeContext } from '@/assistant/context';
import { decodeModelDelta, finishToolCalls, readModelConfig, startModelStream } from '@/assistant/provider';
import type { ChatLine, AssistantEvent } from '@/assistant/provider';
import { isCrossSite } from '@/app/api/index/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 24_000;
const MAX_MESSAGES = 16;
const MAX_MESSAGE_LENGTH = 3_000;
const REQUESTS_PER_MINUTE = 12;
const limits = new Map<string, { count: number; until: number }>();

function error(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });
}

function allowed(request: Request): boolean {
  const expected = process.env['BURSAR_ASSISTANT_ACCESS_TOKEN'];
  const supplied = request.headers.get('x-bursar-assistant-token');
  if (!expected || !supplied || expected.length < 24) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function withinLimit(key: string): boolean {
  const now = Date.now();
  for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
  const current = limits.get(key);
  if (!current) { limits.set(key, { count: 1, until: now + 60_000 }); return true; }
  if (current.count >= REQUESTS_PER_MINUTE) return false;
  current.count++;
  return true;
}

function parseMessages(value: unknown): ChatLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) throw new Error('Invalid conversation length.');
  const lines = value.map((line: unknown): ChatLine => {
    if (!line || typeof line !== 'object') throw new Error('Invalid conversation message.');
    const m = line as Record<string, unknown>;
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.length > MAX_MESSAGE_LENGTH) {
      throw new Error('Invalid conversation content.');
    }
    return { role: m.role, content: m.content };
  });
  if (lines.at(-1)?.role !== 'user') throw new Error('The latest message must come from the user.');
  return lines;
}

export async function POST(request: Request): Promise<Response> {
  if (process.env['BURSAR_ASSISTANT_ENABLED'] !== 'true') return error('Assistant is disabled.', 404);
  if (isCrossSite(request)) return error('Cross-site requests are refused.', 403);
  if (!allowed(request)) return error('Assistant access token required.', 401);
  if (!withinLimit('operator')) return error('Assistant request limit reached.', 429);
  const config = readModelConfig();
  if (!config) return error('Assistant model is not configured.', 503);
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) return error('Request too large.', 413);
  let lines: ChatLine[];
  let context: ReturnType<typeof sanitizeContext>;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return error('Request too large.', 413);
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid request body.');
    const obj = parsed as Record<string, unknown>;
    lines = parseMessages(obj.messages);
    context = sanitizeContext(obj.context);
  } catch {
    return error('Invalid assistant request.', 400);
  }

  let upstream: Response;
  try {
    upstream = await startModelStream(config, lines, context, AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]));
  } catch {
    return error('The configured model is unreachable.', 502);
  }
  if (!upstream.ok || !upstream.body) return error('The model provider refused the request (' + upstream.status + ').', 502);

  const encoder = new TextEncoder();
  const output = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AssistantEvent) => controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const calls = new Map<number, { name: string; args: string }>();
      let buffer = '';
      let emitted = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/gu, '\n');
          if (buffer.length > 150_000) throw new Error('Model stream too large.');
          let separator = buffer.indexOf('\n\n');
          while (separator >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
            if (data && data !== '[DONE]') {
              const parsed: unknown = JSON.parse(data);
              const delta = decodeModelDelta(parsed);
              if (delta.text) {
                emitted += delta.text.length;
                if (emitted > 16_000) throw new Error('Assistant response limit reached.');
                emit({ type: 'delta', text: delta.text });
              }
              for (const call of delta.calls ?? []) {
                if (call.index < 0 || call.index > 2) throw new Error('Invalid tool call index.');
                const previous = calls.get(call.index) ?? { name: '', args: '' };
                const next = { name: previous.name + (call.name ?? ''), args: previous.args + (call.args ?? '') };
                if (next.args.length > 8_000) throw new Error('Tool proposal limit reached.');
                calls.set(call.index, next);
              }
            }
            separator = buffer.indexOf('\n\n');
          }
        }
        const proposal = finishToolCalls(calls);
        if (proposal) emit({ type: 'proposal', proposal });
        emit({ type: 'done' });
      } catch (caught) {
        const message = caught instanceof AssistantRefusal ? caught.message : 'The model response could not be completed.';
        emit({ type: 'error', message });
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
    cancel() { void upstream.body?.cancel().catch(() => undefined); },
  });
  return new Response(output, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' },
  });
}
