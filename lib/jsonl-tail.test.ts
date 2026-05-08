import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startJsonlActivityWatcher } from './jsonl-tail.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jsonl-tail-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Wait long enough that mtime will tick on the platform's filesystem
// granularity (HFS+/APFS often round to ms; ext4 fine; just be safe).
async function waitMs(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('startJsonlActivityWatcher', () => {
  test('does not fire on existing files at start (seeds lastSeen)', async () => {
    writeFileSync(join(tmp, 'session-1.jsonl'), '{"type":"old"}\n');
    let count = 0;
    const w = startJsonlActivityWatcher({
      projectsDir: tmp,
      onActivity: () => { count++; },
      pollMs: 30,
    });
    await waitMs(100);
    w.stop();
    expect(count).toBe(0);
  });

  test('fires when an existing jsonl is appended to', async () => {
    const path = join(tmp, 'session-1.jsonl');
    writeFileSync(path, '{"type":"old"}\n');
    let count = 0;
    const w = startJsonlActivityWatcher({
      projectsDir: tmp,
      onActivity: () => { count++; },
      pollMs: 30,
    });
    await waitMs(50);
    appendFileSync(path, '{"type":"new"}\n');
    await waitMs(80);
    w.stop();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('fires when a new jsonl appears', async () => {
    let count = 0;
    const w = startJsonlActivityWatcher({
      projectsDir: tmp,
      onActivity: () => { count++; },
      pollMs: 30,
    });
    await waitMs(50);
    writeFileSync(join(tmp, 'fresh-session.jsonl'), '{"type":"new"}\n');
    await waitMs(80);
    w.stop();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('ignores non-jsonl files in the directory', async () => {
    writeFileSync(join(tmp, 'README.md'), 'hi\n');
    let count = 0;
    const w = startJsonlActivityWatcher({
      projectsDir: tmp,
      onActivity: () => { count++; },
      pollMs: 30,
    });
    await waitMs(50);
    appendFileSync(join(tmp, 'README.md'), 'more\n');
    await waitMs(80);
    w.stop();
    expect(count).toBe(0);
  });

  test('missing projectsDir is fine — watcher just no-ops until it appears', async () => {
    const missing = join(tmp, 'does-not-exist-yet');
    let count = 0;
    const w = startJsonlActivityWatcher({
      projectsDir: missing,
      onActivity: () => { count++; },
      pollMs: 30,
    });
    await waitMs(80);
    expect(count).toBe(0);
    w.stop();
  });

  test('stop() cancels further callbacks', async () => {
    let count = 0;
    const w = startJsonlActivityWatcher({
      projectsDir: tmp,
      onActivity: () => { count++; },
      pollMs: 20,
    });
    w.stop();
    writeFileSync(join(tmp, 'after-stop.jsonl'), '{}\n');
    await waitMs(80);
    expect(count).toBe(0);
  });
});
