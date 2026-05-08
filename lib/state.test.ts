import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIdle, makeBotStateStore } from './state.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'state-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('makeBotStateStore', () => {
  test('read() on missing state returns defaults', () => {
    const store = makeBotStateStore({ baseDir: tmp });
    expect(store.read('zulip-fleet')).toEqual({
      name: 'zulip-fleet',
      last_active: null,
      session_id: null,
      broken: null,
    });
  });

  test('write() then read() roundtrips', () => {
    const store = makeBotStateStore({ baseDir: tmp });
    store.write({
      name: 'zulip-fleet',
      last_active: '2026-05-08T20:00:00.000Z',
      session_id: 'abc',
      broken: null,
    });
    expect(store.read('zulip-fleet').session_id).toBe('abc');
  });

  test('bumpActivity() sets last_active to now', () => {
    const store = makeBotStateStore({ baseDir: tmp });
    const before = new Date('2026-05-08T20:00:00.000Z');
    store.bumpActivity('zulip-fleet', before);
    expect(store.read('zulip-fleet').last_active).toBe(before.toISOString());
  });
});

describe('isIdle', () => {
  test('null last_active is never idle (no activity yet, don\'t kill)', () => {
    expect(isIdle({ lastActive: null, thresholdMs: 30 * 60 * 1000, now: Date.now() })).toBe(false);
  });

  test('returns false when within threshold', () => {
    const now = Date.parse('2026-05-08T20:30:00.000Z');
    expect(
      isIdle({ lastActive: '2026-05-08T20:25:00.000Z', thresholdMs: 30 * 60 * 1000, now }),
    ).toBe(false);
  });

  test('returns true when past threshold', () => {
    const now = Date.parse('2026-05-08T21:00:00.000Z');
    expect(
      isIdle({ lastActive: '2026-05-08T20:00:00.000Z', thresholdMs: 30 * 60 * 1000, now }),
    ).toBe(true);
  });

  test('unparseable timestamp is never idle (degraded-safe)', () => {
    expect(
      isIdle({ lastActive: 'not-a-date', thresholdMs: 30 * 60 * 1000, now: Date.now() }),
    ).toBe(false);
  });
});

describe('regression: spawn must reset idle clock', () => {
  // The bug: a bot's last_active persists across sessions on disk. If a bot
  // has been asleep for hours and is then respawned, the next idle sweep at
  // t+60s will see "idle 4h" and SIGTERM the freshly-spawned bot before it
  // can reply. Fix: bumpActivity at spawn so isIdle is false until the new
  // session has had a real chance to be idle.
  test('bumpActivity-on-spawn keeps a stale-state bot non-idle', () => {
    const store = makeBotStateStore({ baseDir: tmp });
    // Pretend the bot was last seen 4 hours ago.
    store.write({
      name: 'zulip-fleet',
      last_active: '2026-05-08T16:00:00.000Z',
      session_id: 'old',
      broken: null,
    });
    const stale = store.read('zulip-fleet');
    const spawnTime = new Date('2026-05-08T20:00:00.000Z');
    const sweepTime = spawnTime.getTime() + 60_000; // sweep one minute later
    const threshold = 30 * 60 * 1000;

    // Without the fix: stale state, sweep would shut it down.
    expect(isIdle({ lastActive: stale.last_active, thresholdMs: threshold, now: sweepTime })).toBe(true);

    // With the fix (bumpActivity at spawn): not idle.
    store.bumpActivity('zulip-fleet', spawnTime);
    const fresh = store.read('zulip-fleet');
    expect(isIdle({ lastActive: fresh.last_active, thresholdMs: threshold, now: sweepTime })).toBe(false);
  });
});
