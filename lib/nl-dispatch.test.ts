import { describe, expect, test } from 'bun:test';
import { nlDispatch, parseClaudeResponse, type SpawnFn, type SpawnResult } from './nl-dispatch.ts';

function fakeSpawn(stdout: string, opts: Partial<SpawnResult> = {}): SpawnFn {
  return async () => ({
    stdout,
    stderr: '',
    code: 0,
    timedOut: false,
    ...opts,
  });
}

describe('parseClaudeResponse', () => {
  test('clean single-line JSON', () => {
    expect(parseClaudeResponse('{"kind":"spinUp","target":"writer"}')).toEqual({
      kind: 'spinUp',
      target: 'writer',
    });
  });

  test('json fenced in markdown', () => {
    const out = '```json\n{"kind":"status","target":"briefing"}\n```';
    expect(parseClaudeResponse(out)).toEqual({ kind: 'status', target: 'briefing' });
  });

  test('preamble before json', () => {
    const out = 'Here is the command:\n{"kind":"listActive"}';
    expect(parseClaudeResponse(out)).toEqual({ kind: 'listActive' });
  });

  test('malformed json returns null', () => {
    expect(parseClaudeResponse('{not json')).toBeNull();
    expect(parseClaudeResponse('')).toBeNull();
  });

  test('kind:none returns null', () => {
    expect(parseClaudeResponse('{"kind":"none"}')).toBeNull();
  });

  test('strips leading @ on target', () => {
    expect(parseClaudeResponse('{"kind":"spinUp","target":"@writer"}')).toEqual({
      kind: 'spinUp',
      target: 'writer',
    });
  });

  test('strips leading # on stream', () => {
    expect(parseClaudeResponse('{"kind":"setFolder","stream":"#linear","folder":"work"}')).toEqual({
      kind: 'setFolder',
      stream: 'linear',
      folder: 'work',
    });
  });

  test('lowercases target', () => {
    expect(parseClaudeResponse('{"kind":"shutDown","target":"Writer"}')).toEqual({
      kind: 'shutDown',
      target: 'writer',
    });
  });

  test('rejects unknown kind', () => {
    expect(parseClaudeResponse('{"kind":"explode","target":"writer"}')).toBeNull();
  });

  test('rejects targetless verb', () => {
    expect(parseClaudeResponse('{"kind":"spinUp"}')).toBeNull();
    expect(parseClaudeResponse('{"kind":"reset"}')).toBeNull();
  });

  test('rejects invalid token in target', () => {
    expect(parseClaudeResponse('{"kind":"spinUp","target":"my bot"}')).toBeNull();
    expect(parseClaudeResponse('{"kind":"spinUp","target":""}')).toBeNull();
  });

  test('status without target is fleet-wide', () => {
    expect(parseClaudeResponse('{"kind":"status"}')).toEqual({ kind: 'status', target: undefined });
  });

  test('create with optional flags', () => {
    expect(parseClaudeResponse('{"kind":"create","target":"writer","configDir":"~/.claude-mimo"}')).toEqual({
      kind: 'create',
      target: 'writer',
      configDir: '~/.claude-mimo',
    });
    expect(parseClaudeResponse('{"kind":"create","target":"writer","noSpin":true}')).toEqual({
      kind: 'create',
      target: 'writer',
      noSpin: true,
    });
  });

  test('logs defaults n to 30', () => {
    expect(parseClaudeResponse('{"kind":"logs","target":"writer"}')).toEqual({
      kind: 'logs',
      target: 'writer',
      n: 30,
    });
    expect(parseClaudeResponse('{"kind":"logs","target":"writer","n":100}')).toEqual({
      kind: 'logs',
      target: 'writer',
      n: 100,
    });
  });

  test('createFolder with description', () => {
    expect(parseClaudeResponse('{"kind":"createFolder","name":"work","description":"day-job stuff"}')).toEqual({
      kind: 'createFolder',
      name: 'work',
      description: 'day-job stuff',
    });
  });

  test('help', () => {
    expect(parseClaudeResponse('{"kind":"help"}')).toEqual({ kind: 'help' });
  });
});

describe('nlDispatch', () => {
  test('returns Command from spawned stdout', async () => {
    const cmd = await nlDispatch('start writer', {
      spawn: fakeSpawn('{"kind":"spinUp","target":"writer"}'),
    });
    expect(cmd).toEqual({ kind: 'spinUp', target: 'writer' });
  });

  test('non-zero exit returns null', async () => {
    const cmd = await nlDispatch('start writer', {
      spawn: fakeSpawn('{"kind":"spinUp","target":"writer"}', { code: 1 }),
    });
    expect(cmd).toBeNull();
  });

  test('timeout returns null', async () => {
    const cmd = await nlDispatch('start writer', {
      spawn: fakeSpawn('', { timedOut: true }),
    });
    expect(cmd).toBeNull();
  });

  test('thrown spawn returns null', async () => {
    const cmd = await nlDispatch('start writer', {
      spawn: async () => { throw new Error('claude not on PATH'); },
    });
    expect(cmd).toBeNull();
  });

  test('passes claude CLI args including --print, --model, --append-system-prompt', async () => {
    let capturedArgs: string[] = [];
    let capturedInput = '';
    const cmd = await nlDispatch('shut down writer', {
      spawn: async (args, input) => {
        capturedArgs = args;
        capturedInput = input;
        return { stdout: '{"kind":"shutDown","target":"writer"}', stderr: '', code: 0, timedOut: false };
      },
    });
    expect(cmd).toEqual({ kind: 'shutDown', target: 'writer' });
    expect(capturedArgs[0]).toBe('claude');
    expect(capturedArgs).toContain('--print');
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).toContain('--append-system-prompt');
    expect(capturedInput).toBe('shut down writer');
  });

  test('honors custom model', async () => {
    let capturedArgs: string[] = [];
    await nlDispatch('hi', {
      model: 'claude-sonnet-4-6',
      spawn: async (args) => {
        capturedArgs = args;
        return { stdout: '{"kind":"none"}', stderr: '', code: 0, timedOut: false };
      },
    });
    const modelIdx = capturedArgs.indexOf('--model');
    expect(capturedArgs[modelIdx + 1]).toBe('claude-sonnet-4-6');
  });

  test('honors custom timeout', async () => {
    let capturedTimeout = -1;
    await nlDispatch('hi', {
      timeoutMs: 5000,
      spawn: async (_args, _input, t) => {
        capturedTimeout = t;
        return { stdout: '{"kind":"none"}', stderr: '', code: 0, timedOut: false };
      },
    });
    expect(capturedTimeout).toBe(5000);
  });
});
