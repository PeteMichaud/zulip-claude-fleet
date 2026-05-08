// Per-message liveness reactions on the inbound message. The operator can
// glance at the message and tell whether the bot has it, is actively working,
// has gone quiet, or has replied — without scrolling for a status message.
//
// Stage flow:
//   note()      → 👀 eyes      (received, no activity yet)
//   activity    → 🛠️ wrench    (Claude is writing — tool calls, tokens streaming)
//   silence ≥30s→ ⌛ hourglass  (no JSONL activity for 30s; possibly wedged)
//   activity    → 🛠️ wrench    (back to working from hourglass)
//   ack()       → ✓ check      (reply landed)
//
// Activity is signalled by the channel server tailing the session JSONL
// (lib/jsonl-tail.ts). Any new bytes in the bot's session file count as
// "activity" — Claude wrote a new event (tool call, partial assistant
// message, result, etc.). We don't parse the contents because liveness is
// purely a binary "did the file grow recently" signal.
//
// Emoji names (`eyes`, `wrench`, `hourglass`, `check`) are all in Zulip's
// default emoji set. Earlier `white_check_mark` choice silently 400'd on
// our realm; `check` is known to work via the existing permission relay.

import type { ZulipClient } from './zulip.ts';

export const STAGE_EMOJI = {
  eyes: 'eyes',
  working: 'wrench',
  long: 'hourglass',
  done: 'check',
} as const;
export type Stage = keyof typeof STAGE_EMOJI;

export type StageEvent =
  | { kind: 'note' }
  | { kind: 'activity' }
  | { kind: 'tick'; silenceMs: number }
  | { kind: 'ack' };

// Pure state-machine reducer. Extracted for unit-testability without timers.
// `done` is sticky — once acked we don't re-escalate even if more activity
// signals arrive. `note` resets to eyes (used for fresh inbounds).
export function nextStage(
  current: Stage,
  event: StageEvent,
  longSilenceMs: number,
): Stage {
  if (current === 'done') return 'done';
  switch (event.kind) {
    case 'note':
      return 'eyes';
    case 'activity':
      // De-escalate from long → working too. eyes → working is the first-
      // activity signal; long → working signals "back from silence."
      if (current === 'eyes' || current === 'long') return 'working';
      return current;
    case 'tick':
      if (event.silenceMs >= longSilenceMs && current !== 'long') return 'long';
      return current;
    case 'ack':
      return 'done';
  }
}

export type Heartbeat = {
  note(messageId: number): void;
  bumpActivity(): void;
  ack(): Promise<void>;
  pendingCount(): number;
};

const LONG_SILENCE_MS = 30_000;
const TICK_INTERVAL_MS = 1_000;

type Pending = {
  msgId: number;
  stage: Stage;
  startedAt: number;
  lastActivityAt: number | null;
};

export function makeHeartbeat(
  zulip: ZulipClient,
  log: (...parts: unknown[]) => void = () => {},
  opts: { longSilenceMs?: number; tickIntervalMs?: number } = {},
): Heartbeat {
  const longSilenceMs = opts.longSilenceMs ?? LONG_SILENCE_MS;
  const tickIntervalMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
  const pending = new Map<number, Pending>();
  let tickHandle: ReturnType<typeof setInterval> | null = null;

  function react(msgId: number, emoji: string, method: 'POST' | 'DELETE') {
    return zulip(`/messages/${msgId}/reactions`, {
      method,
      params: { emoji_name: emoji },
    });
  }

  async function transition(p: Pending, target: Stage): Promise<void> {
    if (p.stage === target) return;
    const fromEmoji = STAGE_EMOJI[p.stage];
    const toEmoji = STAGE_EMOJI[target];
    p.stage = target;
    try {
      await react(p.msgId, fromEmoji, 'DELETE');
    } catch {
      // The previous stage's reaction may not have landed yet (POSTs are
      // fire-and-forget for stage entry). Falling through is fine; the
      // transition's ADD below is what the operator needs to see.
    }
    try {
      await react(p.msgId, toEmoji, 'POST');
    } catch (err: any) {
      log(`heartbeat: ${target} react failed (non-fatal):`, err.message);
    }
  }

  function ensureTicker() {
    if (tickHandle) return;
    tickHandle = setInterval(() => {
      const now = Date.now();
      for (const p of pending.values()) {
        const lastActivity = p.lastActivityAt ?? p.startedAt;
        const silenceMs = now - lastActivity;
        const target = nextStage(p.stage, { kind: 'tick', silenceMs }, longSilenceMs);
        if (target !== p.stage) {
          transition(p, target).catch(() => {});
        }
      }
    }, tickIntervalMs);
  }

  function stopTickerIfIdle() {
    if (pending.size === 0 && tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  return {
    note(messageId: number) {
      pending.set(messageId, {
        msgId: messageId,
        stage: 'eyes',
        startedAt: Date.now(),
        lastActivityAt: null,
      });
      // Fire-and-forget initial 👀 — don't block message handoff to Claude.
      react(messageId, STAGE_EMOJI.eyes, 'POST').catch((err: any) =>
        log('heartbeat: eyes react failed (non-fatal):', err.message),
      );
      ensureTicker();
    },

    bumpActivity() {
      const now = Date.now();
      for (const p of pending.values()) {
        p.lastActivityAt = now;
        const target = nextStage(p.stage, { kind: 'activity' }, longSilenceMs);
        if (target !== p.stage) {
          transition(p, target).catch(() => {});
        }
      }
    },

    async ack() {
      if (pending.size === 0) return;
      const items = Array.from(pending.values());
      pending.clear();
      stopTickerIfIdle();
      for (const p of items) {
        await transition(p, 'done');
      }
    },

    pendingCount() {
      return pending.size;
    },
  };
}
