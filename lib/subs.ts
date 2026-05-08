// Self-heal stream subscriptions for dispatch-bot. The dispatcher's event
// queue only delivers messages from streams dispatch-bot is subscribed to;
// if a stream gets manually unsubscribed in the Zulip UI, inbounds vanish
// silently. Run this at startup to make subscriptions match the registry.
// Idempotent: Zulip POST /users/me/subscriptions returns `subscribed`
// (newly-added) and `already_subscribed` separately, so calling it on a
// fully-up-to-date set is a no-op aside from a single API call.

import type { ZulipClient } from './zulip.ts';

export async function selfHealSubscriptions(opts: {
  zulip: ZulipClient;
  myEmail: string;
  streamNames: string[];
  log?: (...parts: unknown[]) => void;
}): Promise<{ added: string[]; alreadySubscribed: number }> {
  const log = opts.log ?? (() => {});
  if (opts.streamNames.length === 0) {
    return { added: [], alreadySubscribed: 0 };
  }
  try {
    const result: any = await opts.zulip('/users/me/subscriptions', {
      method: 'POST',
      params: {
        subscriptions: opts.streamNames.map((name) => ({ name })),
      },
    });
    const added = Object.keys(result?.subscribed?.[opts.myEmail] ?? {});
    const alreadySubscribed = opts.streamNames.length - added.length;
    if (added.length > 0) {
      log(`subscribed dispatch-bot to: [${added.join(', ')}]`);
    } else {
      log(`already subscribed to all ${opts.streamNames.length} bot home streams`);
    }
    return { added, alreadySubscribed };
  } catch (err: any) {
    log(`WARN: self-subscribe failed (${err.message}) — inbounds may not be received`);
    return { added: [], alreadySubscribed: 0 };
  }
}
