// Dispatcher boot sequence: auth check + self-heal subscriptions. Bundled
// into one function so the wiring is a single call site in dispatcher.ts and
// the contract — "by the time this returns, dispatch-bot is authenticated
// AND subscribed to every home stream in the registry" — is testable end
// to end against a fake ZulipClient.

import type { ZulipClient } from './zulip.ts';
import { selfHealSubscriptions } from './subs.ts';

export type StartupResult = {
  me: { email: string; user_id: number; [k: string]: unknown };
  subscribedAdded: string[];
};

export type StartupRegistry = Record<string, { home_stream: string }>;

export async function runStartupSequence(opts: {
  zulip: ZulipClient;
  registry: StartupRegistry;
  log?: (...parts: unknown[]) => void;
}): Promise<StartupResult> {
  const log = opts.log ?? (() => {});

  let me: any;
  try {
    me = await opts.zulip('/users/me');
  } catch (err: any) {
    throw new Error(`Zulip auth failed at startup: ${err.message}`);
  }
  log(
    `auth ok: ${me.email} (user_id ${me.user_id}); registered bots: [${Object.keys(opts.registry).join(', ')}]`,
  );

  const { added } = await selfHealSubscriptions({
    zulip: opts.zulip,
    myEmail: me.email,
    streamNames: Object.values(opts.registry).map((b) => b.home_stream),
    log,
  });

  return { me, subscribedAdded: added };
}
