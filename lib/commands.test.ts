import { describe, expect, test } from 'bun:test';
import { parseCommand } from './commands.ts';

describe('parseCommand', () => {
  test('spin up (synonyms, hyphen-or-space between words)', () => {
    expect(parseCommand('spin up briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('spin-up briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('spin up @briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('SPIN UP briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('start briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('wake up briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('wake-up briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('wake briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    // Zulip's autocomplete inserts formal @**name-bot** mentions
    expect(parseCommand('wake up @**briefing**')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('wake up @**briefing-bot**')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('spin up @**Briefing-Bot**')).toEqual({ kind: 'spinUp', target: 'briefing' });
  });

  test('reset', () => {
    expect(parseCommand('reset briefing')).toEqual({ kind: 'reset', target: 'briefing' });
    expect(parseCommand('reset @briefing')).toEqual({ kind: 'reset', target: 'briefing' });
    expect(parseCommand('Reset briefing')).toEqual({ kind: 'reset', target: 'briefing' });
  });

  test('create (variants, includes legacy create-bot alias)', () => {
    expect(parseCommand('create writer')).toEqual({ kind: 'create', target: 'writer' });
    expect(parseCommand('create-bot writer')).toEqual({ kind: 'create', target: 'writer' });
    expect(parseCommand('create bot writer')).toEqual({ kind: 'create', target: 'writer' });
    expect(parseCommand('createbot writer')).toEqual({ kind: 'create', target: 'writer' });
    expect(parseCommand('CREATE-BOT writer')).toEqual({ kind: 'create', target: 'writer' });
    expect(parseCommand('create @writer')).toEqual({ kind: 'create', target: 'writer' });
    expect(parseCommand('create test-bot-1')).toEqual({ kind: 'create', target: 'test-bot-1' });
  });

  test('create with --config flag', () => {
    expect(parseCommand('create writer --config ~/.claude-mimo')).toEqual({
      kind: 'create',
      target: 'writer',
      configDir: '~/.claude-mimo',
    });
    expect(parseCommand('create writer --config=~/.claude-mimo')).toEqual({
      kind: 'create',
      target: 'writer',
      configDir: '~/.claude-mimo',
    });
    // Order shouldn't matter — flag before positional should parse the same.
    expect(parseCommand('create --config ~/.claude-mimo writer')).toEqual({
      kind: 'create',
      target: 'writer',
      configDir: '~/.claude-mimo',
    });
  });

  test('create with --no-spin opts out of auto spin-up', () => {
    expect(parseCommand('create writer --no-spin')).toEqual({
      kind: 'create',
      target: 'writer',
      noSpin: true,
    });
    expect(parseCommand('create writer --no-spin --config ~/.claude-mimo')).toEqual({
      kind: 'create',
      target: 'writer',
      configDir: '~/.claude-mimo',
      noSpin: true,
    });
    // Default: no --no-spin → noSpin field absent (auto spin-up is on).
    expect(parseCommand('create writer')).toEqual({ kind: 'create', target: 'writer' });
  });

  test('update with --config / --clear-config', () => {
    expect(parseCommand('update writer --config ~/.claude-mimo')).toEqual({
      kind: 'update',
      target: 'writer',
      configDir: '~/.claude-mimo',
    });
    expect(parseCommand('update writer --clear-config')).toEqual({
      kind: 'update',
      target: 'writer',
      clearConfig: true,
    });
    expect(parseCommand('update writer')).toEqual({ kind: 'update', target: 'writer' });
    expect(parseCommand('update @writer --config /abs/path')).toEqual({
      kind: 'update',
      target: 'writer',
      configDir: '/abs/path',
    });
  });

  test('retire', () => {
    expect(parseCommand('retire writer')).toEqual({ kind: 'retire', target: 'writer' });
    expect(parseCommand('retire @writer')).toEqual({ kind: 'retire', target: 'writer' });
  });

  test('shut down (synonyms, hyphen-or-space between words)', () => {
    expect(parseCommand('shut down briefing')).toEqual({ kind: 'shutDown', target: 'briefing' });
    expect(parseCommand('shut-down briefing')).toEqual({ kind: 'shutDown', target: 'briefing' });
    expect(parseCommand('shut  down  briefing')).toEqual({ kind: 'shutDown', target: 'briefing' });
    expect(parseCommand('stop briefing')).toEqual({ kind: 'shutDown', target: 'briefing' });
    expect(parseCommand('kill @briefing')).toEqual({ kind: 'shutDown', target: 'briefing' });
  });

  test('list active (hyphen-or-space)', () => {
    expect(parseCommand('list')).toEqual({ kind: 'listActive' });
    expect(parseCommand('list active')).toEqual({ kind: 'listActive' });
    expect(parseCommand('list-active')).toEqual({ kind: 'listActive' });
    expect(parseCommand('LIST ACTIVE')).toEqual({ kind: 'listActive' });
  });

  test('status with optional target', () => {
    expect(parseCommand('status')).toEqual({ kind: 'status', target: undefined });
    expect(parseCommand('status briefing')).toEqual({ kind: 'status', target: 'briefing' });
    expect(parseCommand('status @briefing')).toEqual({ kind: 'status', target: 'briefing' });
  });

  test('logs with default and explicit n', () => {
    expect(parseCommand('logs briefing')).toEqual({ kind: 'logs', target: 'briefing', n: 30 });
    expect(parseCommand('logs @briefing 50')).toEqual({ kind: 'logs', target: 'briefing', n: 50 });
    expect(parseCommand('log briefing')).toEqual({ kind: 'logs', target: 'briefing', n: 30 }); // singular form
    expect(parseCommand('logs briefing 1')).toEqual({ kind: 'logs', target: 'briefing', n: 1 });
  });

  test('help', () => {
    expect(parseCommand('help')).toEqual({ kind: 'help' });
    expect(parseCommand('Help')).toEqual({ kind: 'help' });
  });

  test('unknown', () => {
    expect(parseCommand('foo bar')).toEqual({ kind: 'unknown', text: 'foo bar' });
    expect(parseCommand('')).toEqual({ kind: 'unknown', text: '' });
    expect(parseCommand('spin up')).toEqual({ kind: 'unknown', text: 'spin up' }); // missing target
    expect(parseCommand('spin')).toEqual({ kind: 'unknown', text: 'spin' });
  });

  test('whitespace tolerance', () => {
    expect(parseCommand('  spin up briefing  ')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('\nstatus\n')).toEqual({ kind: 'status', target: undefined });
  });
});
