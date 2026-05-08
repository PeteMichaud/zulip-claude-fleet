import { describe, expect, test } from 'bun:test';
import { makeSpawnOrchestrator } from './spawn-orchestrator.ts';

type FakeBot = { name: string };

function recorder() {
  const events: string[] = [];
  return {
    events,
    note: (e: string) => events.push(e),
  };
}

describe('makeSpawnOrchestrator', () => {
  // The bug we hit on 2026-05-08: a bot that had been asleep for 4h was
  // respawned via `spin up`. The next idle sweep at t+60s saw last_active
  // from 4h ago, ruled it idle, and SIGTERMed it before it could reply.
  // Fix: bump idle clock at spawn. The orchestrator encodes this as a
  // mandatory step. This test would fail if anyone reorders or removes it.
  test('regression: bumpActivity fires BEFORE spawnBot', async () => {
    const r = recorder();
    const orch = makeSpawnOrchestrator<FakeBot, unknown>({
      isAlive: () => false,
      bumpActivity: () => r.note('bump'),
      spawnBot: async () => { r.note('spawn'); },
    });
    await orch.maybeSpawn({ name: 'zulip-fleet' }, {});
    expect(r.events).toEqual(['bump', 'spawn']);
  });

  test('skips spawn (and bump) if bot is already alive', async () => {
    const r = recorder();
    const orch = makeSpawnOrchestrator<FakeBot, unknown>({
      isAlive: () => true,
      bumpActivity: () => r.note('bump'),
      spawnBot: async () => { r.note('spawn'); },
    });
    await orch.maybeSpawn({ name: 'zulip-fleet' }, {});
    expect(r.events).toEqual([]);
  });

  test('spawn failure logs and does not throw', async () => {
    const logs: string[] = [];
    const orch = makeSpawnOrchestrator<FakeBot, unknown>({
      isAlive: () => false,
      bumpActivity: () => {},
      spawnBot: async () => { throw new Error('PTY helper failed'); },
      log: (...parts) => logs.push(parts.join(' ')),
    });
    await expect(orch.maybeSpawn({ name: 'zulip-fleet' }, {})).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('spawn failed') && l.includes('PTY helper failed'))).toBe(true);
  });

  test('serializes concurrent spawn attempts: only one spawnBot fires', async () => {
    const r = recorder();
    let alive = false;
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((res) => { releaseSpawn = res; });
    const orch = makeSpawnOrchestrator<FakeBot, unknown>({
      isAlive: () => alive,
      bumpActivity: () => r.note('bump'),
      spawnBot: async () => {
        r.note('spawn-start');
        await spawnGate;
        alive = true; // mimic "subprocess registered as running"
        r.note('spawn-end');
      },
    });

    const p1 = orch.maybeSpawn({ name: 'zulip-fleet' }, {});
    const p2 = orch.maybeSpawn({ name: 'zulip-fleet' }, {});
    // Let p1 progress through the lock + bump + spawn-start
    await Promise.resolve();
    await Promise.resolve();
    releaseSpawn();
    await Promise.all([p1, p2]);

    // Only one bump + one spawn (the second caller saw isAlive after the first finished).
    expect(r.events.filter((e) => e === 'bump')).toHaveLength(1);
    expect(r.events.filter((e) => e === 'spawn-start')).toHaveLength(1);
    expect(r.events.filter((e) => e === 'spawn-end')).toHaveLength(1);
  });
});
