// Zulip stream-typing pulses while Claude is mid-turn. Pairs with the
// emoji-reaction heartbeat (lib/heartbeat.ts) but operates on the live
// typing-indicator channel: an "@bot is typing…" affordance the operator
// can glance at without scrolling for reaction emoji.
//
// Lifecycle:
//   note(stream, topic)    → operator just sent a message; begin pulsing
//   bumpActivity()         → JSONL activity tick; refresh the pulse
//   stop()                 → reply landed (or operator forced quiet)
//
// Refresh cadence is below Zulip's ~15s server-side TTL so the indicator
// stays visible while Claude is working. Auto-quiesces after a longer
// silence so a wedged bot doesn't appear "still typing" for minutes —
// the ⌛ reaction takes over as the operator's "this is stuck" signal.
//
// Stream-typing in Zulip requires `to: [stream_id]` (a list with one
// numeric id) — the channel's *name* is not accepted. Stream ids are
// resolved lazily via /get_stream_id and cached for the process lifetime;
// stream renames mid-session would invalidate the cache, but home streams
// don't rename in practice.

import type { ZulipClient } from './zulip.ts';
import { getStreamId } from './zulip-admin.ts';

const REFRESH_MS = 10_000;
const QUIET_THRESHOLD_MS = 30_000;
const TICK_INTERVAL_MS = 1_000;

export type TypingIndicator = {
  note(stream: string, topic: string): void;
  bumpActivity(): void;
  stop(): Promise<void>;
  isEmitting(): boolean;
};

export type TypingIndicatorOpts = {
  refreshMs?: number;
  quietThresholdMs?: number;
  tickIntervalMs?: number;
  resolveStreamId?: (name: string) => Promise<number | null>;
};

export function makeTypingIndicator(
  zulip: ZulipClient,
  log: (...parts: unknown[]) => void = () => {},
  opts: TypingIndicatorOpts = {},
): TypingIndicator {
  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  const quietMs = opts.quietThresholdMs ?? QUIET_THRESHOLD_MS;
  const tickMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
  const streamIdCache = new Map<string, number>();
  const resolveStreamId = opts.resolveStreamId ?? (async (name: string) => {
    if (streamIdCache.has(name)) return streamIdCache.get(name)!;
    try {
      const id = await getStreamId(zulip, name);
      streamIdCache.set(name, id);
      return id;
    } catch (err: any) {
      log('typing: stream_id lookup failed for', name, '—', err.message);
      return null;
    }
  });

  let context: { stream: string; topic: string } | null = null;
  let emitting = false;
  let lastActivity = 0;
  let lastStartAt = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;

  async function emit(op: 'start' | 'stop', stream: string, topic: string): Promise<void> {
    const id = await resolveStreamId(stream);
    if (id === null) return;
    try {
      await zulip('/typing', {
        method: 'POST',
        params: { type: 'stream', op, to: [id], topic },
      });
    } catch (err: any) {
      log(`typing: ${op} failed (non-fatal):`, err.message);
    }
  }

  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (!emitting || !context) {
        stopTicker();
        return;
      }
      const now = Date.now();
      if (now - lastActivity > quietMs) {
        // Long silence — pair with the ⌛ heartbeat reaction.
        const { stream, topic } = context;
        emitting = false;
        stopTicker();
        emit('stop', stream, topic).catch(() => { /* logged in emit */ });
        return;
      }
      if (now - lastStartAt >= refreshMs) {
        lastStartAt = now;
        emit('start', context.stream, context.topic).catch(() => { /* logged in emit */ });
      }
    }, tickMs);
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function arm(stream: string, topic: string): void {
    lastActivity = Date.now();
    if (emitting) return;
    emitting = true;
    lastStartAt = Date.now();
    emit('start', stream, topic).catch(() => { /* logged in emit */ });
    ensureTicker();
  }

  return {
    note(stream, topic) {
      const switching = context && (context.stream !== stream || context.topic !== topic);
      if (switching && emitting) {
        const old = context!;
        emit('stop', old.stream, old.topic).catch(() => { /* logged */ });
        emitting = false;
      }
      context = { stream, topic };
      arm(stream, topic);
    },

    bumpActivity() {
      if (!context) return;
      arm(context.stream, context.topic);
    },

    async stop() {
      stopTicker();
      if (!emitting || !context) return;
      const { stream, topic } = context;
      emitting = false;
      await emit('stop', stream, topic);
    },

    isEmitting() {
      return emitting;
    },
  };
}
