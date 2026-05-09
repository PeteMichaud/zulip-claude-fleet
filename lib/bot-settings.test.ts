import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBotSettings } from './bot-settings.ts';

let tmp: string;
const HOOK = '/abs/path/to/enforce-send.ts';

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'bot-settings-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function read(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('ensureBotSettings', () => {
  test('creates the file when missing, with hook + permission allowlist', () => {
    const r = ensureBotSettings({ cwd: tmp, hookScriptPath: HOOK });
    expect(r.changed).toBe(true);
    const out = read(r.path);
    expect(out.permissions.allow).toContain('mcp__zulip-channel__*');
    expect(out.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: HOOK });
  });

  test('idempotent: second call with same shape leaves file untouched', () => {
    const r1 = ensureBotSettings({ cwd: tmp, hookScriptPath: HOOK });
    const before = readFileSync(r1.path, 'utf-8');
    const r2 = ensureBotSettings({ cwd: tmp, hookScriptPath: HOOK });
    expect(r2.changed).toBe(false);
    expect(readFileSync(r2.path, 'utf-8')).toBe(before);
  });

  test('migrates an old settings file (preserves operator-added allows)', () => {
    mkdirSync(join(tmp, '.claude'));
    writeFileSync(
      join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['mcp__zulip-channel__*', 'Bash(git:*)'] },
        // No hooks block in the old file
      }) + '\n',
    );
    const r = ensureBotSettings({ cwd: tmp, hookScriptPath: HOOK });
    expect(r.changed).toBe(true);
    const out = read(r.path);
    expect(out.permissions.allow).toEqual(['mcp__zulip-channel__*', 'Bash(git:*)']);
    expect(out.hooks.Stop[0].hooks[0].command).toBe(HOOK);
  });

  test('adds the required allow entry if missing', () => {
    mkdirSync(join(tmp, '.claude'));
    writeFileSync(
      join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'] } }) + '\n',
    );
    const r = ensureBotSettings({ cwd: tmp, hookScriptPath: HOOK });
    const out = read(r.path);
    expect(out.permissions.allow).toEqual(['Bash(git:*)', 'mcp__zulip-channel__*']);
  });

  test('preserves unrelated top-level keys', () => {
    mkdirSync(join(tmp, '.claude'));
    writeFileSync(
      join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { FOO: 'bar' }, customKey: 42 }) + '\n',
    );
    const r = ensureBotSettings({ cwd: tmp, hookScriptPath: HOOK });
    const out = read(r.path);
    expect(out.env).toEqual({ FOO: 'bar' });
    expect(out.customKey).toBe(42);
  });

  test('rebuilds from scratch when existing JSON is unparseable', () => {
    mkdirSync(join(tmp, '.claude'));
    writeFileSync(join(tmp, '.claude', 'settings.local.json'), '{ not json');
    const r = ensureBotSettings({ cwd: tmp, hookScriptPath: HOOK });
    expect(r.changed).toBe(true);
    const out = read(r.path);
    expect(out.permissions.allow).toContain('mcp__zulip-channel__*');
    expect(out.hooks.Stop[0].hooks[0].command).toBe(HOOK);
  });

  test('updates the hook command when the path changes', () => {
    ensureBotSettings({ cwd: tmp, hookScriptPath: '/old/path.ts' });
    const r = ensureBotSettings({ cwd: tmp, hookScriptPath: '/new/path.ts' });
    expect(r.changed).toBe(true);
    const out = read(r.path);
    expect(out.hooks.Stop[0].hooks[0].command).toBe('/new/path.ts');
  });

  test('creates the .claude directory when missing', () => {
    expect(existsSync(join(tmp, '.claude'))).toBe(false);
    const r = ensureBotSettings({ cwd: tmp, hookScriptPath: HOOK });
    expect(existsSync(r.path)).toBe(true);
  });
});
