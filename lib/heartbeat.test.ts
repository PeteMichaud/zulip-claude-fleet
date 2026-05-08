import { describe, expect, test } from 'bun:test';
import {
  makeHeartbeat,
  nextStage,
  STAGE_EMOJI,
  type Stage,
} from './heartbeat.ts';
import { makeFakeZulipClient } from './zulip-fake.ts';

const LONG_MS = 30_000;

describe('nextStage (pure reducer)', () => {
  test('note resets any non-done stage to eyes', () => {
    expect(nextStage('eyes', { kind: 'note' }, LONG_MS)).toBe('eyes');
    expect(nextStage('working', { kind: 'note' }, LONG_MS)).toBe('eyes');
    expect(nextStage('long', { kind: 'note' }, LONG_MS)).toBe('eyes');
  });

  test('done is sticky — no further transitions', () => {
    expect(nextStage('done', { kind: 'note' }, LONG_MS)).toBe('done');
    expect(nextStage('done', { kind: 'activity' }, LONG_MS)).toBe('done');
    expect(nextStage('done', { kind: 'tick', silenceMs: 99_999 }, LONG_MS)).toBe('done');
    expect(nextStage('done', { kind: 'ack' }, LONG_MS)).toBe('done');
  });

  test('activity transitions eyes/long → working; working stays working', () => {
    expect(nextStage('eyes', { kind: 'activity' }, LONG_MS)).toBe('working');
    expect(nextStage('long', { kind: 'activity' }, LONG_MS)).toBe('working');
    expect(nextStage('working', { kind: 'activity' }, LONG_MS)).toBe('working');
  });

  test('tick: stays in stage until silence ≥ longSilenceMs, then → long', () => {
    expect(nextStage('eyes', { kind: 'tick', silenceMs: 5_000 }, LONG_MS)).toBe('eyes');
    expect(nextStage('eyes', { kind: 'tick', silenceMs: LONG_MS }, LONG_MS)).toBe('long');
    expect(nextStage('working', { kind: 'tick', silenceMs: 29_999 }, LONG_MS)).toBe('working');
    expect(nextStage('working', { kind: 'tick', silenceMs: LONG_MS }, LONG_MS)).toBe('long');
    // Already long: no further escalation, stays long.
    expect(nextStage('long', { kind: 'tick', silenceMs: 999_999 }, LONG_MS)).toBe('long');
  });

  test('ack always → done', () => {
    const stages: Stage[] = ['eyes', 'working', 'long'];
    for (const s of stages) {
      expect(nextStage(s, { kind: 'ack' }, LONG_MS)).toBe('done');
    }
  });
});

describe('makeHeartbeat (real timers, async react calls)', () => {
  test('note() posts 👀 reaction', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake);
    hb.note(123);
    await Promise.resolve();
    const r = fake.callsTo('/messages/123/reactions', 'POST');
    expect(r).toHaveLength(1);
    expect(r[0].params).toEqual({ emoji_name: STAGE_EMOJI.eyes });
    await hb.ack(); // cleanup ticker
  });

  test('ack() with no prior activity goes 👀 → ✓', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake);
    hb.note(10);
    await hb.ack();
    expect(hb.pendingCount()).toBe(0);

    const del = fake.callsTo('/messages/10/reactions', 'DELETE');
    expect(del[0].params).toEqual({ emoji_name: STAGE_EMOJI.eyes });
    const post = fake.callsTo('/messages/10/reactions', 'POST');
    expect(post.map((c) => c.params)).toEqual([
      { emoji_name: STAGE_EMOJI.eyes },
      { emoji_name: STAGE_EMOJI.done },
    ]);
  });

  test('bumpActivity() transitions eyes → working (👀 → 🛠️)', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake);
    hb.note(7);
    hb.bumpActivity();

    // Wait for the transition's async DELETE/POST to flush.
    await new Promise((r) => setTimeout(r, 20));

    const del = fake.callsTo('/messages/7/reactions', 'DELETE');
    expect(del.some((c) => (c.params as any).emoji_name === STAGE_EMOJI.eyes)).toBe(true);
    const post = fake.callsTo('/messages/7/reactions', 'POST');
    expect(post.some((c) => (c.params as any).emoji_name === STAGE_EMOJI.working)).toBe(true);
    await hb.ack();
  });

  test('tick: silence ≥ longSilenceMs swaps current stage → long (🛠️/👀 → ⌛)', async () => {
    const fake = makeFakeZulipClient();
    // Fast tick (10ms) + tiny longSilenceMs (50ms) so the test runs in ~70ms.
    const hb = makeHeartbeat(fake, undefined, { tickIntervalMs: 10, longSilenceMs: 50 });
    hb.note(99);
    // Don't bump activity. After ~70ms the ticker should escalate to 'long'.
    await new Promise((r) => setTimeout(r, 80));
    const post = fake.callsTo('/messages/99/reactions', 'POST');
    expect(post.some((c) => (c.params as any).emoji_name === STAGE_EMOJI.long)).toBe(true);
    await hb.ack();
  });

  test('activity after long → working (⌛ → 🛠️)', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake, undefined, { tickIntervalMs: 10, longSilenceMs: 30 });
    hb.note(42);
    await new Promise((r) => setTimeout(r, 60)); // → long
    hb.bumpActivity();                            // → working
    await new Promise((r) => setTimeout(r, 20));
    const post = fake.callsTo('/messages/42/reactions', 'POST');
    // We should see the working emoji posted at least twice — no, actually:
    // first: eyes (initial), then long (escalation), then working (after bump).
    expect(post.map((c) => (c.params as any).emoji_name)).toEqual([
      STAGE_EMOJI.eyes,
      STAGE_EMOJI.long,
      STAGE_EMOJI.working,
    ]);
    await hb.ack();
  });

  test('ack() empty pending is a no-op', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake);
    await hb.ack();
    expect(fake.calls).toHaveLength(0);
  });

  test('note() failure does not throw (fire-and-forget)', async () => {
    const fake = makeFakeZulipClient({
      'POST /messages/55/reactions': () => { throw new Error('zulip down'); },
    });
    const hb = makeHeartbeat(fake);
    expect(() => hb.note(55)).not.toThrow();
    await Promise.resolve();
    await hb.ack();
  });

  test('multiple pending: each tracks its own stage and acks independently', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake);
    hb.note(1);
    hb.note(2);
    expect(hb.pendingCount()).toBe(2);
    await hb.ack();
    expect(hb.pendingCount()).toBe(0);
    expect(fake.callsTo('/messages/1/reactions', 'POST').some((c) => (c.params as any).emoji_name === STAGE_EMOJI.done)).toBe(true);
    expect(fake.callsTo('/messages/2/reactions', 'POST').some((c) => (c.params as any).emoji_name === STAGE_EMOJI.done)).toBe(true);
  });
});
