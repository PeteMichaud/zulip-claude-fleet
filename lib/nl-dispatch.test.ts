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
  test('clean single-line JSON array', () => {
    expect(parseClaudeResponse('[{"kind":"spinUp","target":"writer"}]')).toEqual([
      { kind: 'spinUp', target: 'writer' },
    ]);
  });

  test('multi-step plan in execution order', () => {
    const out = '[{"kind":"createFolder","name":"SFC"},{"kind":"setFolder","stream":"briefing","folder":"SFC"}]';
    expect(parseClaudeResponse(out)).toEqual([
      { kind: 'createFolder', name: 'SFC' },
      { kind: 'setFolder', stream: 'briefing', folder: 'SFC' },
    ]);
  });

  test('json array fenced in markdown', () => {
    const out = '```json\n[{"kind":"status","target":"briefing"}]\n```';
    expect(parseClaudeResponse(out)).toEqual([{ kind: 'status', target: 'briefing' }]);
  });

  test('preamble before json array', () => {
    const out = 'Here is the plan:\n[{"kind":"listActive"}]';
    expect(parseClaudeResponse(out)).toEqual([{ kind: 'listActive' }]);
  });

  test('empty array means "no command"', () => {
    expect(parseClaudeResponse('[]')).toEqual([]);
  });

  test('malformed json returns null', () => {
    expect(parseClaudeResponse('[not json')).toBeNull();
    expect(parseClaudeResponse('')).toBeNull();
  });

  test('non-array top level returns null', () => {
    // The protocol is "always an array" — a single object is malformed.
    expect(parseClaudeResponse('{"kind":"spinUp","target":"writer"}')).toBeNull();
  });

  test('any invalid element fails the whole plan', () => {
    expect(parseClaudeResponse('[{"kind":"spinUp","target":"writer"},{"kind":"explode"}]')).toBeNull();
  });

  test('strips leading @ on target', () => {
    expect(parseClaudeResponse('[{"kind":"spinUp","target":"@writer"}]')).toEqual([
      { kind: 'spinUp', target: 'writer' },
    ]);
  });

  test('strips leading # on stream', () => {
    expect(parseClaudeResponse('[{"kind":"setFolder","stream":"#linear","folder":"work"}]')).toEqual([
      { kind: 'setFolder', stream: 'linear', folder: 'work' },
    ]);
  });

  test('lowercases target', () => {
    expect(parseClaudeResponse('[{"kind":"shutDown","target":"Writer"}]')).toEqual([
      { kind: 'shutDown', target: 'writer' },
    ]);
  });

  test('preserves folder name case (descriptive label, not identifier)', () => {
    expect(parseClaudeResponse('[{"kind":"createFolder","name":"SFC"}]')).toEqual([
      { kind: 'createFolder', name: 'SFC' },
    ]);
    expect(parseClaudeResponse('[{"kind":"createFolder","name":"Personal"}]')).toEqual([
      { kind: 'createFolder', name: 'Personal' },
    ]);
  });

  test('rejects targetless verb', () => {
    expect(parseClaudeResponse('[{"kind":"spinUp"}]')).toBeNull();
    expect(parseClaudeResponse('[{"kind":"reset"}]')).toBeNull();
  });

  test('rejects invalid token in target', () => {
    expect(parseClaudeResponse('[{"kind":"spinUp","target":"my bot"}]')).toBeNull();
    expect(parseClaudeResponse('[{"kind":"spinUp","target":""}]')).toBeNull();
  });

  test('status without target is fleet-wide', () => {
    expect(parseClaudeResponse('[{"kind":"status"}]')).toEqual([
      { kind: 'status', target: undefined },
    ]);
  });

  test('create with optional flags', () => {
    expect(parseClaudeResponse('[{"kind":"create","target":"writer","configDir":"~/.claude-mimo"}]')).toEqual([
      { kind: 'create', target: 'writer', configDir: '~/.claude-mimo' },
    ]);
    expect(parseClaudeResponse('[{"kind":"create","target":"writer","noSpin":true}]')).toEqual([
      { kind: 'create', target: 'writer', noSpin: true },
    ]);
  });

  test('logs defaults n to 30', () => {
    expect(parseClaudeResponse('[{"kind":"logs","target":"writer"}]')).toEqual([
      { kind: 'logs', target: 'writer', n: 30 },
    ]);
    expect(parseClaudeResponse('[{"kind":"logs","target":"writer","n":100}]')).toEqual([
      { kind: 'logs', target: 'writer', n: 100 },
    ]);
  });

  test('createFolder with description', () => {
    expect(parseClaudeResponse('[{"kind":"createFolder","name":"Work","description":"day-job stuff"}]')).toEqual([
      { kind: 'createFolder', name: 'Work', description: 'day-job stuff' },
    ]);
  });

  test('help', () => {
    expect(parseClaudeResponse('[{"kind":"help"}]')).toEqual([{ kind: 'help' }]);
  });

  // The exact symptom from 2026-05-08: Pete typed
  //   "1. pin zulip-fleet 2. move briefing and linear into a new stream
  //    folder called SFC 3. create a blank folder called Personal"
  // and the dispatcher answered "unrecognized" because the protocol mapped
  // multi-step inputs to {"kind":"none"} → null. With the array protocol,
  // the same input round-trips through Claude as a 5-step plan with SFC
  // preserved as-typed. This test pins both fixes (multi-step + folder case).
  test('regression: 2026-05-08 multi-step "pin/move/create" input round-trips', () => {
    const claudeOutput = JSON.stringify([
      { kind: 'createFolder', name: 'SFC' },
      { kind: 'setFolder', stream: 'briefing', folder: 'SFC' },
      { kind: 'setFolder', stream: 'linear', folder: 'SFC' },
      { kind: 'createFolder', name: 'Personal' },
      { kind: 'pin', target: 'zulip-fleet' },
    ]);
    const plan = parseClaudeResponse(claudeOutput);
    expect(plan).toEqual([
      { kind: 'createFolder', name: 'SFC' },
      { kind: 'setFolder', stream: 'briefing', folder: 'SFC' },
      { kind: 'setFolder', stream: 'linear', folder: 'SFC' },
      { kind: 'createFolder', name: 'Personal' },
      { kind: 'pin', target: 'zulip-fleet' },
    ]);
  });
});

describe('nlDispatch', () => {
  test('returns plan from spawned stdout', async () => {
    const plan = await nlDispatch('start writer', {
      spawn: fakeSpawn('[{"kind":"spinUp","target":"writer"}]'),
    });
    expect(plan).toEqual([{ kind: 'spinUp', target: 'writer' }]);
  });

  test('multi-step plan returned in order', async () => {
    const plan = await nlDispatch('pin briefing then create folder X', {
      spawn: fakeSpawn('[{"kind":"pin","target":"briefing"},{"kind":"createFolder","name":"X"}]'),
    });
    expect(plan).toEqual([
      { kind: 'pin', target: 'briefing' },
      { kind: 'createFolder', name: 'X' },
    ]);
  });

  test('non-zero exit returns null', async () => {
    expect(
      await nlDispatch('x', { spawn: fakeSpawn('[]', { code: 1 }) }),
    ).toBeNull();
  });

  test('timeout returns null', async () => {
    expect(
      await nlDispatch('x', { spawn: fakeSpawn('', { timedOut: true }) }),
    ).toBeNull();
  });

  test('thrown spawn returns null', async () => {
    expect(
      await nlDispatch('x', { spawn: async () => { throw new Error('claude not on PATH'); } }),
    ).toBeNull();
  });

  test('passes claude CLI args including --print, --model, --append-system-prompt', async () => {
    let capturedArgs: string[] = [];
    let capturedInput = '';
    const plan = await nlDispatch('shut down writer', {
      spawn: async (args, input) => {
        capturedArgs = args;
        capturedInput = input;
        return { stdout: '[{"kind":"shutDown","target":"writer"}]', stderr: '', code: 0, timedOut: false };
      },
    });
    expect(plan).toEqual([{ kind: 'shutDown', target: 'writer' }]);
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
        return { stdout: '[]', stderr: '', code: 0, timedOut: false };
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
        return { stdout: '[]', stderr: '', code: 0, timedOut: false };
      },
    });
    expect(capturedTimeout).toBe(5000);
  });
});
