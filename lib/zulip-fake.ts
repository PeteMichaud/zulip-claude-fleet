// Fake Zulip client for tests. Records every call and dispatches to optional
// per-route handlers. Routes are keyed by `${METHOD} ${path}` (e.g. "POST
// /messages/123/reactions"); a path-only key matches any method as a fallback.
// Default response is { result: 'success' } so most calls don't need scripting.

import type { ZulipClient, ZulipCallOptions } from './zulip.ts';

export type RecordedCall = {
  path: string;
  method: string;
  params?: Record<string, unknown>;
};

export type RouteHandler = (
  params: Record<string, unknown> | undefined,
) => unknown | Promise<unknown>;

export type FakeZulipClient = ZulipClient & {
  calls: RecordedCall[];
  setRoute(key: string, handler: RouteHandler): void;
  callsTo(path: string, method?: string): RecordedCall[];
};

export function makeFakeZulipClient(
  initialRoutes: Record<string, RouteHandler> = {},
): FakeZulipClient {
  const calls: RecordedCall[] = [];
  const routes = new Map<string, RouteHandler>(Object.entries(initialRoutes));

  const client = (async (path: string, opts: ZulipCallOptions = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, params: opts.params });
    const handler = routes.get(`${method} ${path}`) ?? routes.get(path);
    if (handler) return await handler(opts.params);
    return { result: 'success' };
  }) as FakeZulipClient;

  client.calls = calls;
  client.setRoute = (key, handler) => { routes.set(key, handler); };
  client.callsTo = (path, method) =>
    calls.filter((c) => c.path === path && (!method || c.method === method));

  return client;
}
