import { describe, expect, test } from 'bun:test';
import { makeTypingIndicator } from './typing-indicator.ts';
import { makeFakeZulipClient } from './zulip-fake.ts';

function fakeResolver(name: string): Promise<number | null> {
  // Deterministic stream-id mapping for tests so we don't hit /get_stream_id.
  if (name === 'home') return Promise.resolve(42);
  if (name === 'other') return Promise.resolve(99);
  return Promise.resolve(null);
}

function typingCalls(zulip: ReturnType<typeof makeFakeZulipClient>) {
  return zulip.callsTo('/typing', 'POST');
}

async function flush() {
  // Yield once so fire-and-forget emits get scheduled.
  await new Promise((r) => setTimeout(r, 5));
}

describe('makeTypingIndicator', () => {
  test('note() emits start with the resolved stream_id and topic', async () => {
    const zulip = makeFakeZulipClient();
    const indicator = makeTypingIndicator(zulip, () => {}, { resolveStreamId: fakeResolver });
    indicator.note('home', 'chat');
    await flush();

    const calls = typingCalls(zulip);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({ type: 'stream', op: 'start', stream_id: 42, topic: 'chat' });
    expect(indicator.isEmitting()).toBe(true);
    await indicator.stop();
  });

  test('stop() emits stop and clears emitting flag', async () => {
    const zulip = makeFakeZulipClient();
    const indicator = makeTypingIndicator(zulip, () => {}, { resolveStreamId: fakeResolver });
    indicator.note('home', 'chat');
    await flush();
    await indicator.stop();

    const calls = typingCalls(zulip);
    expect(calls).toHaveLength(2);
    expect(calls[1].params).toMatchObject({ op: 'stop', stream_id: 42, topic: 'chat' });
    expect(indicator.isEmitting()).toBe(false);
  });

  test('bumpActivity() with no context is a no-op', async () => {
    const zulip = makeFakeZulipClient();
    const indicator = makeTypingIndicator(zulip, () => {}, { resolveStreamId: fakeResolver });
    indicator.bumpActivity();
    await flush();
    expect(typingCalls(zulip)).toHaveLength(0);
    expect(indicator.isEmitting()).toBe(false);
  });

  test('bumpActivity() re-arms after stop() within the same context', async () => {
    const zulip = makeFakeZulipClient();
    const indicator = makeTypingIndicator(zulip, () => {}, { resolveStreamId: fakeResolver });
    indicator.note('home', 'chat');
    await flush();
    await indicator.stop();
    indicator.bumpActivity();
    await flush();

    const ops = typingCalls(zulip).map((c) => c.params!.op);
    expect(ops).toEqual(['start', 'stop', 'start']);
    await indicator.stop();
  });

  test('switching context stops the old conversation before starting the new one', async () => {
    const zulip = makeFakeZulipClient();
    const indicator = makeTypingIndicator(zulip, () => {}, { resolveStreamId: fakeResolver });
    indicator.note('home', 'chat');
    await flush();
    indicator.note('other', 'design');
    await flush();

    const calls = typingCalls(zulip);
    // Expect: start(home), stop(home), start(other)
    expect(calls.map((c) => [c.params!.op, c.params!.stream_id, c.params!.topic])).toEqual([
      ['start', 42, 'chat'],
      ['stop', 42, 'chat'],
      ['start', 99, 'design'],
    ]);
    await indicator.stop();
  });

  test('ticker refreshes start after refreshMs and auto-stops after quietThresholdMs', async () => {
    const zulip = makeFakeZulipClient();
    const indicator = makeTypingIndicator(zulip, () => {}, {
      resolveStreamId: fakeResolver,
      refreshMs: 30,
      quietThresholdMs: 80,
      tickIntervalMs: 10,
    });
    indicator.note('home', 'chat');
    // Wait through one refresh window then long enough to trip the quiet timer.
    await new Promise((r) => setTimeout(r, 120));

    const ops = typingCalls(zulip).map((c) => c.params!.op);
    // At least: initial start, one refresh start, one auto-stop.
    expect(ops[0]).toBe('start');
    expect(ops.filter((o) => o === 'start').length).toBeGreaterThanOrEqual(2);
    expect(ops[ops.length - 1]).toBe('stop');
    expect(indicator.isEmitting()).toBe(false);
  });

  test('bumpActivity keeps the pulse alive past the quiet threshold', async () => {
    const zulip = makeFakeZulipClient();
    const indicator = makeTypingIndicator(zulip, () => {}, {
      resolveStreamId: fakeResolver,
      refreshMs: 30,
      quietThresholdMs: 50,
      tickIntervalMs: 10,
    });
    indicator.note('home', 'chat');
    // Bump every 20ms (well under quietThresholdMs) for a window where the
    // quiet timer would otherwise fire.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 20));
      indicator.bumpActivity();
    }
    expect(indicator.isEmitting()).toBe(true);
    await indicator.stop();
  });

  test('emit failures are swallowed (Zulip outage must not crash the loop)', async () => {
    const zulip = makeFakeZulipClient({
      'POST /typing': () => { throw new Error('boom'); },
    });
    const messages: string[] = [];
    const indicator = makeTypingIndicator(zulip, (...parts) => { messages.push(parts.join(' ')); }, {
      resolveStreamId: fakeResolver,
    });
    indicator.note('home', 'chat');
    await flush();
    await indicator.stop();
    expect(messages.some((m) => m.includes('typing:'))).toBe(true);
  });

  test('unknown stream resolves to null and emits nothing', async () => {
    const zulip = makeFakeZulipClient();
    const indicator = makeTypingIndicator(zulip, () => {}, { resolveStreamId: fakeResolver });
    indicator.note('nonexistent', 'chat');
    await flush();
    expect(typingCalls(zulip)).toHaveLength(0);
    await indicator.stop();
  });
});
