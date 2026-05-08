// Catch-up fetch for messages missed during a Zulip event-queue death.
//
// Background: dispatcher.ts and zulip-channel.ts both consume Zulip's
// long-poll event queue. If the queue expires (network blip, server-side
// GC, dispatcher restart while messages were inbound), the next /events
// call returns BAD_EVENT_QUEUE_ID and the buffered events on that queue
// are gone. Re-registering gets a fresh queue but only sees future events,
// so any messages that arrived during the gap are silently dropped.
//
// Mitigation: the caller tracks its own "last successfully handled message
// id" bookmark, separate from the queue's `last_event_id`. After re-
// register, fetch /messages with `anchor: bookmark, include_anchor: false,
// num_after: N` to recover anything in the gap, replay each through the
// caller's normal handler. Idempotency is the caller's responsibility —
// most handlers here are already safe (wake-spawn checks isAlive, command
// dispatch is operator-driven), and the bookmark advances strictly
// forward so a successful re-run doesn't re-replay.

import type { ZulipClient } from './zulip.ts';

const DEFAULT_CATCHUP_LIMIT = 200;

export async function fetchMessagesSince(opts: {
  zulip: ZulipClient;
  sinceMessageId: number;
  narrow?: unknown[];
  limit?: number;
}): Promise<any[]> {
  const data = await opts.zulip('/messages', {
    params: {
      anchor: opts.sinceMessageId,
      include_anchor: false,
      num_before: 0,
      num_after: opts.limit ?? DEFAULT_CATCHUP_LIMIT,
      narrow: opts.narrow ?? [],
      apply_markdown: false,
    },
  });
  return Array.isArray(data?.messages) ? data.messages : [];
}
