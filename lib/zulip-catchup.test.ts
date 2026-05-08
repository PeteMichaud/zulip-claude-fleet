import { describe, expect, test } from 'bun:test';
import { makeFakeZulipClient } from './zulip-fake.ts';
import { fetchMessagesSince } from './zulip-catchup.ts';

describe('fetchMessagesSince', () => {
  test('asks Zulip for messages strictly after the bookmark', async () => {
    const fake = makeFakeZulipClient({
      'GET /messages': () => ({ result: 'success', messages: [{ id: 101 }, { id: 102 }] }),
    });
    const out = await fetchMessagesSince({ zulip: fake, sinceMessageId: 100 });
    expect(out).toEqual([{ id: 101 }, { id: 102 }]);
    const call = fake.callsTo('/messages')[0];
    expect(call.method).toBe('GET');
    expect(call.params).toMatchObject({
      anchor: 100,
      include_anchor: false,
      num_before: 0,
      num_after: 200,
    });
  });

  test('forwards an optional narrow', async () => {
    const fake = makeFakeZulipClient({
      'GET /messages': () => ({ result: 'success', messages: [] }),
    });
    await fetchMessagesSince({
      zulip: fake,
      sinceMessageId: 0,
      narrow: [['stream', 'briefing']],
    });
    const call = fake.callsTo('/messages')[0];
    expect(call.params?.narrow).toEqual([['stream', 'briefing']]);
  });

  test('honors a custom limit', async () => {
    const fake = makeFakeZulipClient({
      'GET /messages': () => ({ result: 'success', messages: [] }),
    });
    await fetchMessagesSince({ zulip: fake, sinceMessageId: 0, limit: 50 });
    const call = fake.callsTo('/messages')[0];
    expect(call.params?.num_after).toBe(50);
  });

  test('returns empty array when Zulip omits the messages field', async () => {
    const fake = makeFakeZulipClient({
      'GET /messages': () => ({ result: 'success' }),
    });
    const out = await fetchMessagesSince({ zulip: fake, sinceMessageId: 0 });
    expect(out).toEqual([]);
  });
});
