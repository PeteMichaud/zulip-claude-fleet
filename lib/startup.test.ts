import { describe, expect, test } from 'bun:test';
import { runStartupSequence } from './startup.ts';
import { makeFakeZulipClient } from './zulip-fake.ts';

const ME = 'dispatch-bot@example.zulipchat.com';

function fakeWithSubsResult(added: string[]) {
  return makeFakeZulipClient({
    'GET /users/me': () => ({ result: 'success', email: ME, user_id: 1077577 }),
    'POST /users/me/subscriptions': () => ({
      result: 'success',
      subscribed: { [ME]: Object.fromEntries(added.map((n) => [n, true])) },
      already_subscribed: {},
    }),
  });
}

describe('runStartupSequence', () => {
  // The bug we hit on 2026-05-08: dispatch-bot was unsubscribed from a bot's
  // home stream in the Zulip UI, so its event queue silently stopped seeing
  // those messages. Fix: dispatcher self-subscribes at startup. This test
  // would fail if anyone removes the self-heal step from the boot sequence.
  test('regression: subscribes to every home stream in registry on boot', async () => {
    const fake = fakeWithSubsResult(['briefing', 'zulip-fleet']);
    const result = await runStartupSequence({
      zulip: fake,
      registry: {
        briefing: { home_stream: 'briefing' },
        'zulip-fleet': { home_stream: 'zulip-fleet' },
      },
    });
    expect(result.subscribedAdded).toEqual(['briefing', 'zulip-fleet']);

    const subsCall = fake.callsTo('/users/me/subscriptions', 'POST')[0];
    expect(subsCall).toBeDefined();
    expect(subsCall.params).toEqual({
      subscriptions: [{ name: 'briefing' }, { name: 'zulip-fleet' }],
    });
  });

  test('returns me payload from /users/me', async () => {
    const fake = fakeWithSubsResult([]);
    const result = await runStartupSequence({
      zulip: fake,
      registry: {},
    });
    expect(result.me.email).toBe(ME);
    expect(result.me.user_id).toBe(1077577);
  });

  test('empty registry: still does auth check, no subscription POST', async () => {
    const fake = fakeWithSubsResult([]);
    await runStartupSequence({ zulip: fake, registry: {} });
    expect(fake.callsTo('/users/me', 'GET')).toHaveLength(1);
    expect(fake.callsTo('/users/me/subscriptions', 'POST')).toHaveLength(0);
  });

  test('auth failure throws (caller should handle FATAL exit)', async () => {
    const fake = makeFakeZulipClient({
      'GET /users/me': () => { throw new Error('401 Unauthorized'); },
    });
    await expect(
      runStartupSequence({ zulip: fake, registry: {} }),
    ).rejects.toThrow(/Zulip auth failed at startup.*401/);
  });

  test('logs auth-ok summary including registered bot names', async () => {
    const fake = fakeWithSubsResult([]);
    const logs: string[] = [];
    await runStartupSequence({
      zulip: fake,
      registry: {
        briefing: { home_stream: 'briefing' },
        'zulip-fleet': { home_stream: 'zulip-fleet' },
      },
      log: (...parts) => logs.push(parts.join(' ')),
    });
    expect(logs.some((l) => l.includes('auth ok') && l.includes('briefing') && l.includes('zulip-fleet'))).toBe(true);
  });
});
