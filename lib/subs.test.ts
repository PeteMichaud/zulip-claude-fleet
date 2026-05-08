import { describe, expect, test } from 'bun:test';
import { selfHealSubscriptions } from './subs.ts';
import { makeFakeZulipClient } from './zulip-fake.ts';

const ME = 'dispatch-bot@example.zulipchat.com';

describe('selfHealSubscriptions', () => {
  test('POSTs every registered home stream as a subscription', async () => {
    const fake = makeFakeZulipClient({
      'POST /users/me/subscriptions': () => ({
        result: 'success',
        subscribed: { [ME]: { 'briefing': true, 'zulip-fleet': true } },
        already_subscribed: {},
      }),
    });
    const result = await selfHealSubscriptions({
      zulip: fake,
      myEmail: ME,
      streamNames: ['briefing', 'zulip-fleet'],
    });
    expect(result.added).toEqual(['briefing', 'zulip-fleet']);
    const call = fake.callsTo('/users/me/subscriptions', 'POST')[0];
    expect(call.params).toEqual({
      subscriptions: [{ name: 'briefing' }, { name: 'zulip-fleet' }],
    });
  });

  test('reports already-subscribed when Zulip returns no new subscriptions', async () => {
    const fake = makeFakeZulipClient({
      'POST /users/me/subscriptions': () => ({
        result: 'success',
        subscribed: {},
        already_subscribed: { [ME]: { 'briefing': true, 'zulip-fleet': true } },
      }),
    });
    const logs: string[] = [];
    const result = await selfHealSubscriptions({
      zulip: fake,
      myEmail: ME,
      streamNames: ['briefing', 'zulip-fleet'],
      log: (...parts) => logs.push(parts.join(' ')),
    });
    expect(result.added).toEqual([]);
    expect(result.alreadySubscribed).toBe(2);
    expect(logs.some((l) => l.includes('already subscribed'))).toBe(true);
  });

  test('empty registry: no API call made', async () => {
    const fake = makeFakeZulipClient();
    const result = await selfHealSubscriptions({
      zulip: fake,
      myEmail: ME,
      streamNames: [],
    });
    expect(result).toEqual({ added: [], alreadySubscribed: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  test('Zulip error is logged but does not throw', async () => {
    const fake = makeFakeZulipClient({
      'POST /users/me/subscriptions': () => {
        throw new Error('insufficient permission');
      },
    });
    const logs: string[] = [];
    const result = await selfHealSubscriptions({
      zulip: fake,
      myEmail: ME,
      streamNames: ['x'],
      log: (...parts) => logs.push(parts.join(' ')),
    });
    expect(result.added).toEqual([]);
    expect(logs.some((l) => l.includes('WARN: self-subscribe failed'))).toBe(true);
  });
});
