import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/assistant/chat/route';

function request(token?: string): Request {
  return new Request('https://app.bursar.world/api/assistant/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      ...(token ? { 'x-bursar-assistant-token': token } : {}),
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Prepare a draft.' }],
      context: { surface: { kind: 'workspace' }, workspace: { status: 'locked', drafts: [] } },
    }),
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('assistant route denies unauthenticated model spending', () => {
  it('is unreachable while disabled', async () => {
    vi.stubEnv('BURSAR_ASSISTANT_ENABLED', 'false');
    expect((await POST(request())).status).toBe(404);
  });
  it('requires the operator token before using a model', async () => {
    vi.stubEnv('BURSAR_ASSISTANT_ENABLED', 'true');
    vi.stubEnv('BURSAR_ASSISTANT_ACCESS_TOKEN', 'this-is-a-long-operator-password');
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request('incorrect'))).status).toBe(401);
  });
  it('refuses cross-site calls even with a valid operator token', async () => {
    vi.stubEnv('BURSAR_ASSISTANT_ENABLED', 'true');
    vi.stubEnv('BURSAR_ASSISTANT_ACCESS_TOKEN', 'this-is-a-long-operator-password');
    const req = request('this-is-a-long-operator-password');
    const cross = new Request(req, { headers: { ...Object.fromEntries(req.headers), 'sec-fetch-site': 'cross-site' } });
    expect((await POST(cross)).status).toBe(403);
  });
  it('fails closed when the model is not configured', async () => {
    vi.stubEnv('BURSAR_ASSISTANT_ENABLED', 'true');
    vi.stubEnv('BURSAR_ASSISTANT_ACCESS_TOKEN', 'this-is-a-long-operator-password');
    vi.stubEnv('BURSAR_ASSISTANT_API_KEY', '');
    vi.stubEnv('BURSAR_ASSISTANT_MODEL', '');
    expect((await POST(request('this-is-a-long-operator-password'))).status).toBe(503);
  });
});
