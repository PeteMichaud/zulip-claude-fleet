import { describe, expect, test } from 'bun:test';
import { parseCommand } from './commands.ts';

describe('parseCommand', () => {
  test('spin up', () => {
    expect(parseCommand('spin up briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('spin up @briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('SPIN UP briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
    expect(parseCommand('start briefing')).toEqual({ kind: 'spinUp', target: 'briefing' });
  });

  test('shut down (multiple synonyms)', () => {
    expect(parseCommand('shut down briefing')).toEqual({ kind: 'shutDown', target: 'briefing' });
    expect(parseCommand('shut  down  briefing')).toEqual({ kind: 'shutDown', target: 'briefing' }); // multi-space tolerant
    expect(parseCommand('stop briefing')).toEqual({ kind: 'shutDown', target: 'briefing' });
    expect(parseCommand('kill @briefing')).toEqual({ kind: 'shutDown', target: 'briefing' });
  });

  test('list active', () => {
    expect(parseCommand('list')).toEqual({ kind: 'listActive' });
    expect(parseCommand('list active')).toEqual({ kind: 'listActive' });
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
