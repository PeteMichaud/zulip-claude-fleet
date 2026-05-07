import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeZulipClient } from './zulip.ts';

// We swap globalThis.fetch with a recorder. Each test sets up `mockResponse`
// and inspects `lastRequest` after the call. Keeps tests synchronous-feeling
// without pulling in a full HTTP mocking library.

let originalFetch: typeof fetch;
let lastRequest: { url: URL; init: RequestInit } | undefined;
let mockResponse: { status: number; body: unknown };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastRequest = undefined;
  mockResponse = { status: 200, body: { result: 'success', user_id: 1 } };
  globalThis.fetch = ((input: any, init?: any) => {
    const url = input instanceof URL ? input : new URL(String(input));
    lastRequest = { url, init: init ?? {} };
    return Promise.resolve(
      new Response(JSON.stringify(mockResponse.body), {
        status: mockResponse.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SITE = 'https://example.zulipchat.com';
const EMAIL = 'bot@example.zulipchat.com';
const KEY = 'secret-key-123';

describe('makeZulipClient', () => {
  test('GET request: builds URL under /api/v1, sets Basic auth header', async () => {
    const z = makeZulipClient({ site: SITE, email: EMAIL, apiKey: KEY });
    await z('/users/me');

    expect(lastRequest!.url.toString()).toBe(`${SITE}/api/v1/users/me`);
    expect(lastRequest!.init.method ?? 'GET').toBe('GET');
    const expectedAuth =
      'Basic ' + Buffer.from(`${EMAIL}:${KEY}`).toString('base64');
    expect((lastRequest!.init.headers as any).Authorization).toBe(expectedAuth);
  });

  test('GET with params encodes them as query string', async () => {
    const z = makeZulipClient({ site: SITE, email: EMAIL, apiKey: KEY });
    await z('/messages', { params: { anchor: 'newest', num_before: 50 } });

    expect(lastRequest!.url.searchParams.get('anchor')).toBe('newest');
    // Numbers JSON-stringify (so num_before becomes the string "50").
    expect(lastRequest!.url.searchParams.get('num_before')).toBe('50');
  });

  test('GET with object/array param JSON-stringifies it', async () => {
    const z = makeZulipClient({ site: SITE, email: EMAIL, apiKey: KEY });
    await z('/messages', {
      params: { narrow: [['stream', 'briefing']] },
    });

    expect(lastRequest!.url.searchParams.get('narrow')).toBe(
      JSON.stringify([['stream', 'briefing']]),
    );
  });

  test('POST sends form-encoded body, not query string', async () => {
    const z = makeZulipClient({ site: SITE, email: EMAIL, apiKey: KEY });
    await z('/messages', {
      method: 'POST',
      params: { type: 'stream', to: 'briefing', topic: 'chat', content: 'hi' },
    });

    expect(lastRequest!.init.method).toBe('POST');
    expect(lastRequest!.url.search).toBe(''); // no query params
    expect((lastRequest!.init.headers as any)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = String(lastRequest!.init.body);
    const params = new URLSearchParams(body);
    expect(params.get('type')).toBe('stream');
    expect(params.get('content')).toBe('hi');
  });

  test('throws on non-success response', async () => {
    mockResponse = { status: 200, body: { result: 'error', msg: 'nope' } };
    const z = makeZulipClient({ site: SITE, email: EMAIL, apiKey: KEY });
    await expect(z('/users/me')).rejects.toThrow(/Zulip GET \/users\/me failed/);
  });

  test('throws on non-2xx HTTP', async () => {
    mockResponse = { status: 401, body: { result: 'error', msg: 'auth failed' } };
    const z = makeZulipClient({ site: SITE, email: EMAIL, apiKey: KEY });
    await expect(z('/users/me')).rejects.toThrow(/HTTP 401/);
  });

  test('passes AbortSignal through to fetch', async () => {
    const ac = new AbortController();
    const z = makeZulipClient({ site: SITE, email: EMAIL, apiKey: KEY });
    await z('/users/me', { signal: ac.signal });

    expect(lastRequest!.init.signal).toBe(ac.signal);
  });
});
