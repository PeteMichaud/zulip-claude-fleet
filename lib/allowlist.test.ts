import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAllowEntry, derivePattern, matchesAllow } from './allowlist.ts';

describe('derivePattern', () => {
  test('Bash: extracts first command token', () => {
    expect(
      derivePattern('Bash', JSON.stringify({ command: 'git status' })),
    ).toBe('Bash(git:*)');
    expect(
      derivePattern('Bash', JSON.stringify({ command: '  npm   install --save  ' })),
    ).toBe('Bash(npm:*)');
  });

  test('Bash: empty command falls back to bare tool', () => {
    expect(derivePattern('Bash', JSON.stringify({ command: '' }))).toBe('Bash');
    expect(derivePattern('Bash', JSON.stringify({}))).toBe('Bash');
  });

  test('Write/Edit/Read: pin to exact path', () => {
    const args = JSON.stringify({ file_path: '/Users/pete/zulip-claude-fleet/dispatcher.ts' });
    expect(derivePattern('Write', args)).toBe('Write(/Users/pete/zulip-claude-fleet/dispatcher.ts)');
    expect(derivePattern('Edit', args)).toBe('Edit(/Users/pete/zulip-claude-fleet/dispatcher.ts)');
    expect(derivePattern('Read', args)).toBe('Read(/Users/pete/zulip-claude-fleet/dispatcher.ts)');
    expect(derivePattern('NotebookEdit', args)).toBe(
      'NotebookEdit(/Users/pete/zulip-claude-fleet/dispatcher.ts)',
    );
  });

  test('Write missing file_path: bare tool name', () => {
    expect(derivePattern('Write', JSON.stringify({}))).toBe('Write');
  });

  test('mcp tool: name is already specific', () => {
    expect(derivePattern('mcp__zulip-channel__send', '{}')).toBe('mcp__zulip-channel__send');
  });

  test('non-JSON input_preview: bare tool name', () => {
    expect(derivePattern('Bash', 'not json {{')).toBe('Bash');
  });

  test('JSON array (not an object): bare tool name', () => {
    expect(derivePattern('Bash', '[1,2,3]')).toBe('Bash');
  });

  test('null / non-object args: bare tool name', () => {
    expect(derivePattern('Bash', 'null')).toBe('Bash');
    expect(derivePattern('Bash', '"string"')).toBe('Bash');
  });

  test('unknown tool: bare tool name', () => {
    expect(derivePattern('SomeNewTool', '{}')).toBe('SomeNewTool');
  });
});

describe('matchesAllow (inverse of derivePattern)', () => {
  test('Bash(token:*) matches commands with that first token', () => {
    expect(matchesAllow('Bash', JSON.stringify({ command: 'git status' }), 'Bash(git:*)')).toBe(true);
    expect(matchesAllow('Bash', JSON.stringify({ command: 'git push --force' }), 'Bash(git:*)')).toBe(true);
    expect(matchesAllow('Bash', JSON.stringify({ command: 'npm test' }), 'Bash(git:*)')).toBe(false);
    expect(matchesAllow('Bash', JSON.stringify({ command: '   git   diff   ' }), 'Bash(git:*)')).toBe(true);
  });

  test('Bash pattern only matches when toolName is Bash', () => {
    expect(matchesAllow('Write', JSON.stringify({ command: 'git status' }), 'Bash(git:*)')).toBe(false);
  });

  test('round-trip: derive then match the same input', () => {
    const args = JSON.stringify({ command: 'pnpm install' });
    const pattern = derivePattern('Bash', args);
    expect(pattern).toBe('Bash(pnpm:*)');
    expect(matchesAllow('Bash', args, pattern)).toBe(true);
  });

  test('Path-tool patterns: exact file_path match', () => {
    const args = JSON.stringify({ file_path: '/Users/pete/zulip-claude-fleet/dispatcher.ts' });
    expect(matchesAllow('Write', args, 'Write(/Users/pete/zulip-claude-fleet/dispatcher.ts)')).toBe(true);
    expect(matchesAllow('Write', args, 'Write(/Users/pete/zulip-claude-fleet/other.ts)')).toBe(false);
    expect(matchesAllow('Edit', args, 'Write(/Users/pete/zulip-claude-fleet/dispatcher.ts)')).toBe(false);
  });

  test('mcp tool exact match', () => {
    expect(matchesAllow('mcp__zulip-channel__send', '{}', 'mcp__zulip-channel__send')).toBe(true);
    expect(matchesAllow('mcp__zulip-channel__read', '{}', 'mcp__zulip-channel__send')).toBe(false);
  });

  test('bare tool name pattern matches any input for that tool', () => {
    expect(matchesAllow('Bash', JSON.stringify({ command: 'whatever' }), 'Bash')).toBe(true);
    expect(matchesAllow('Write', JSON.stringify({ file_path: '/x' }), 'Write')).toBe(true);
  });

  test('unparseable input never matches a structured pattern', () => {
    expect(matchesAllow('Bash', 'not json', 'Bash(git:*)')).toBe(false);
    expect(matchesAllow('Write', 'not json', 'Write(/some/path)')).toBe(false);
  });
});

describe('appendAllowEntry', () => {
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'allowlist-test-'));
    path = join(tmp, '.claude', 'settings.local.json');
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test('creates file (and parent dir) if missing', () => {
    const result = appendAllowEntry(path, 'Bash(git:*)');
    expect(result).toEqual({ added: true, pattern: 'Bash(git:*)', allow: ['Bash(git:*)'] });
    const stored = JSON.parse(readFileSync(path, 'utf-8'));
    expect(stored.permissions.allow).toEqual(['Bash(git:*)']);
  });

  test('appends to an existing file, preserving prior entries + other keys', () => {
    mkdirSync(join(tmp, '.claude'));
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ['mcp__zulip-channel__*'] },
        someOtherKey: { keep: 'me' },
      }),
    );
    const result = appendAllowEntry(path, 'Bash(git:*)');
    expect(result.added).toBe(true);
    expect(result.allow).toEqual(['mcp__zulip-channel__*', 'Bash(git:*)']);
    const stored = JSON.parse(readFileSync(path, 'utf-8'));
    expect(stored.someOtherKey).toEqual({ keep: 'me' });
    expect(stored.permissions.allow).toEqual(['mcp__zulip-channel__*', 'Bash(git:*)']);
  });

  test('idempotent: existing entry → no-op, file untouched', () => {
    mkdirSync(join(tmp, '.claude'));
    writeFileSync(
      path,
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'] } }) + '\n',
    );
    const before = readFileSync(path, 'utf-8');
    const result = appendAllowEntry(path, 'Bash(git:*)');
    expect(result.added).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  test('initializes permissions / allow if shape is partially missing', () => {
    mkdirSync(join(tmp, '.claude'));
    writeFileSync(path, JSON.stringify({ unrelated: 1 }));
    appendAllowEntry(path, 'Read(/x)');
    const stored = JSON.parse(readFileSync(path, 'utf-8'));
    expect(stored.unrelated).toBe(1);
    expect(stored.permissions.allow).toEqual(['Read(/x)']);
  });

  test('refuses to clobber unparseable JSON', () => {
    mkdirSync(join(tmp, '.claude'));
    writeFileSync(path, '{ this is not json');
    expect(() => appendAllowEntry(path, 'Bash(git:*)')).toThrow(/isn't valid JSON/);
  });
});
