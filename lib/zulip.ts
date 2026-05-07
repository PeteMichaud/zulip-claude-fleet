// Tiny Zulip REST helper. Call sites should construct one client with the
// auth they want (dispatcher uses dispatch-bot creds; channel servers use
// each bot's own creds; the smoke-test script uses whatever's in .env).

export type ZulipCallOptions = {
  method?: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type ZulipClient = (path: string, opts?: ZulipCallOptions) => Promise<any>;

export function makeZulipClient(opts: {
  site: string;
  email: string;
  apiKey: string;
}): ZulipClient {
  const auth =
    'Basic ' + Buffer.from(`${opts.email}:${opts.apiKey}`).toString('base64');

  return async (path, callOpts = {}) => {
    const method = callOpts.method ?? 'GET';
    const url = new URL(`/api/v1${path}`, opts.site);
    const init: RequestInit = {
      method,
      headers: { Authorization: auth },
      signal: callOpts.signal,
    };

    if (callOpts.params) {
      if (method === 'GET') {
        for (const [k, v] of Object.entries(callOpts.params)) {
          url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
        }
      } else {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(callOpts.params)) {
          body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
        }
        init.body = body;
        init.headers = {
          ...init.headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        };
      }
    }

    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data as any).result !== 'success') {
      throw new Error(
        `Zulip ${method} ${path} failed (HTTP ${res.status}): ${JSON.stringify(data)}`,
      );
    }
    return data;
  };
}
