import { describe, expect, test } from 'bun:test';
import { isDestructive, parseCommand, parseTargetToken } from './commands.ts';

describe('isDestructive', () => {
  // Load-bearing for the dispatcher's NL-plan rejection path: any destructive
  // step in a multi-command plan refuses the whole batch (PR #12). If a new
  // destructive verb is added (e.g. "purge"), it must be added here too.
  test('flags retire and reset', () => {
    expect(isDestructive({ kind: 'retire', target: 'foo' })).toBe(true);
    expect(isDestructive({ kind: 'reset', target: 'foo' })).toBe(true);
  });

  test('does not flag non-destructive verbs', () => {
    expect(isDestructive({ kind: 'spinUp', target: 'foo' })).toBe(false);
    expect(isDestructive({ kind: 'shutDown', target: 'foo' })).toBe(false);
    expect(isDestructive({ kind: 'create', target: 'foo' })).toBe(false);
    expect(isDestructive({ kind: 'pin', target: 'foo' })).toBe(false);
    expect(isDestructive({ kind: 'createFolder', name: 'SFC' })).toBe(false);
    expect(isDestructive({ kind: 'setFolder', stream: 'briefing', folder: 'SFC' })).toBe(false);
    expect(isDestructive({ kind: 'listActive' })).toBe(false);
    expect(isDestructive({ kind: 'help' })).toBe(false);
  });
});

describe('parseTargetToken', () => {
  test('strips leading @ or # and lowercases', () => {
    expect(parseTargetToken('briefing')).toBe('briefing');
    expect(parseTargetToken('@briefing')).toBe('briefing');
    expect(parseTargetToken('#briefing')).toBe('briefing');
    expect(parseTargetToken('Briefing')).toBe('briefing');
    expect(parseTargetToken('@Writer-Bot')).toBe('writer-bot');
  });

  test('rejects invalid shapes', () => {
    expect(parseTargetToken(undefined)).toBeUndefined();
    expect(parseTargetToken('')).toBeUndefined();
    expect(parseTargetToken('1bot')).toBeUndefined();           // digit prefix
    expect(parseTargetToken('-bot')).toBeUndefined();           // dash prefix
    expect(parseTargetToken('_bot')).toBeUndefined();           // underscore prefix
    expect(parseTargetToken('bot with space')).toBeUndefined(); // whitespace
    expect(parseTargetToken('bot.name')).toBeUndefined();       // dot
  });
});

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

  test('create with --auto / --yolo enables permission bypass modes', () => {
    expect(parseCommand('create writer --auto')).toEqual({
      kind: 'create', target: 'writer', auto: true,
    });
    expect(parseCommand('create writer --yolo')).toEqual({
      kind: 'create', target: 'writer', yolo: true,
    });
    expect(parseCommand('create writer --auto --yolo')).toEqual({
      kind: 'create', target: 'writer', auto: true, yolo: true,
    });
    // Combined with other flags
    expect(parseCommand('create writer --auto --no-spin --config ~/.claude-mimo')).toEqual({
      kind: 'create', target: 'writer', configDir: '~/.claude-mimo', noSpin: true, auto: true,
    });
  });

  test('update with --auto / --no-auto / --yolo / --no-yolo (tri-state)', () => {
    // Set true
    expect(parseCommand('update writer --auto')).toEqual({
      kind: 'update', target: 'writer', auto: true,
    });
    // Explicit false
    expect(parseCommand('update writer --no-auto')).toEqual({
      kind: 'update', target: 'writer', auto: false,
    });
    expect(parseCommand('update writer --yolo')).toEqual({
      kind: 'update', target: 'writer', yolo: true,
    });
    expect(parseCommand('update writer --no-yolo')).toEqual({
      kind: 'update', target: 'writer', yolo: false,
    });
    // Bare update with no flags: no auto/yolo fields (preserves current values).
    expect(parseCommand('update writer')).toEqual({ kind: 'update', target: 'writer' });
    // Combined with config
    expect(parseCommand('update writer --auto --config ~/.claude-mimo')).toEqual({
      kind: 'update', target: 'writer', configDir: '~/.claude-mimo', auto: true,
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

  test('pin / unpin', () => {
    expect(parseCommand('pin briefing')).toEqual({ kind: 'pin', target: 'briefing' });
    expect(parseCommand('pin zulip-fleet')).toEqual({ kind: 'pin', target: 'zulip-fleet' });
    expect(parseCommand('unpin briefing')).toEqual({ kind: 'unpin', target: 'briefing' });
    expect(parseCommand('pin')).toEqual({ kind: 'unknown', text: 'pin' });
  });

  test('create folder (multi-word + hyphen variants, optional description)', () => {
    expect(parseCommand('create folder SFC')).toEqual({ kind: 'createFolder', name: 'SFC' });
    expect(parseCommand('create-folder SFC')).toEqual({ kind: 'createFolder', name: 'SFC' });
    expect(parseCommand('createfolder Personal')).toEqual({ kind: 'createFolder', name: 'Personal' });
    expect(parseCommand('create folder SFC --description=work')).toEqual({
      kind: 'createFolder', name: 'SFC', description: 'work',
    });
    expect(parseCommand('create folder')).toEqual({ kind: 'unknown', text: 'create folder' });
  });

  test('list folders', () => {
    expect(parseCommand('list folders')).toEqual({ kind: 'listFolders' });
    expect(parseCommand('list-folders')).toEqual({ kind: 'listFolders' });
    expect(parseCommand('LIST FOLDERS')).toEqual({ kind: 'listFolders' });
  });

  test('set folder / clear folder', () => {
    expect(parseCommand('set folder briefing SFC')).toEqual({
      kind: 'setFolder', stream: 'briefing', folder: 'SFC',
    });
    expect(parseCommand('set-folder zulip-fleet SFC')).toEqual({
      kind: 'setFolder', stream: 'zulip-fleet', folder: 'SFC',
    });
    expect(parseCommand('set folder briefing')).toEqual({ kind: 'unknown', text: 'set folder briefing' });
    expect(parseCommand('clear folder briefing')).toEqual({ kind: 'clearFolder', stream: 'briefing' });
    expect(parseCommand('clear-folder zulip-fleet')).toEqual({ kind: 'clearFolder', stream: 'zulip-fleet' });
    expect(parseCommand('clear folder')).toEqual({ kind: 'unknown', text: 'clear folder' });
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
