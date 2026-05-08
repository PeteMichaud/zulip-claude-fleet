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

  test('create-bot (variants)', () => {
    expect(parseCommand('create-bot writer')).toEqual({ kind: 'createBot', target: 'writer' });
    expect(parseCommand('create bot writer')).toEqual({ kind: 'createBot', target: 'writer' });
    expect(parseCommand('createbot writer')).toEqual({ kind: 'createBot', target: 'writer' });
    expect(parseCommand('CREATE-BOT writer')).toEqual({ kind: 'createBot', target: 'writer' });
    expect(parseCommand('create-bot @writer')).toEqual({ kind: 'createBot', target: 'writer' });
    expect(parseCommand('create-bot test-bot-1')).toEqual({ kind: 'createBot', target: 'test-bot-1' });
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
