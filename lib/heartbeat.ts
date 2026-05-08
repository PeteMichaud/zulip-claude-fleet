// Per-message liveness reactions: 👀 when an inbound is handed off to Claude,
// swapped to ✅ on the first reply. The bot's operator gets a per-inbound
// signal of whether the bot saw the message and whether it produced a reply,
// without polluting the chat with extra messages. Caller is responsible for
// invoking `note(msgId)` at handoff and `ack()` after a successful send.

import type { ZulipClient } from './zulip.ts';

export const HEARTBEAT_EYES = 'eyes';
export const HEARTBEAT_DONE = 'white_check_mark';

export type Heartbeat = {
  note(messageId: number): void;
  ack(): Promise<void>;
  pendingCount(): number;
};

export function makeHeartbeat(
  zulip: ZulipClient,
  debug: (...parts: unknown[]) => void = () => {},
): Heartbeat {
  const pending: number[] = [];

  return {
    note(messageId: number) {
      pending.push(messageId);
      // Fire-and-forget: don't block the caller (typically the inbound
      // handoff to Claude) on a reaction POST.
      zulip(`/messages/${messageId}/reactions`, {
        method: 'POST',
        params: { emoji_name: HEARTBEAT_EYES },
      }).catch((err: any) =>
        debug('heartbeat: 👀 react failed (non-fatal):', err.message),
      );
    },

    async ack() {
      if (pending.length === 0) return;
      const ids = pending.splice(0);
      for (const id of ids) {
        try {
          await zulip(`/messages/${id}/reactions`, {
            method: 'DELETE',
            params: { emoji_name: HEARTBEAT_EYES },
          });
        } catch {
          // 👀 may not have landed yet (note() is fire-and-forget) or the
          // operator already removed it manually. Either way, fall through
          // and add the ✅ regardless.
        }
        try {
          await zulip(`/messages/${id}/reactions`, {
            method: 'POST',
            params: { emoji_name: HEARTBEAT_DONE },
          });
        } catch (err: any) {
          debug('heartbeat: ✅ react failed (non-fatal):', err.message);
        }
      }
    },

    pendingCount() {
      return pending.length;
    },
  };
}
