import { describe, expect, test } from 'bun:test';
import { HEARTBEAT_DONE, HEARTBEAT_EYES, makeHeartbeat } from './heartbeat.ts';
import { makeFakeZulipClient } from './zulip-fake.ts';

describe('heartbeat', () => {
  test('note() reacts 👀 on the inbound message', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake);
    hb.note(123);
    // note() is fire-and-forget — let the microtask flush.
    await Promise.resolve();
    const reactCalls = fake.callsTo('/messages/123/reactions', 'POST');
    expect(reactCalls).toHaveLength(1);
    expect(reactCalls[0].params).toEqual({ emoji_name: HEARTBEAT_EYES });
  });

  test('ack() removes 👀 and adds ✅ for every pending inbound', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake);
    hb.note(10);
    hb.note(20);
    expect(hb.pendingCount()).toBe(2);
    await hb.ack();
    expect(hb.pendingCount()).toBe(0);

    const del10 = fake.callsTo('/messages/10/reactions', 'DELETE');
    const del20 = fake.callsTo('/messages/20/reactions', 'DELETE');
    expect(del10[0].params).toEqual({ emoji_name: HEARTBEAT_EYES });
    expect(del20[0].params).toEqual({ emoji_name: HEARTBEAT_EYES });

    // Each id gets exactly one POST 👀 (from note) and one POST ✅ (from ack).
    const post10 = fake.callsTo('/messages/10/reactions', 'POST');
    const post20 = fake.callsTo('/messages/20/reactions', 'POST');
    expect(post10.map((c) => c.params)).toEqual([
      { emoji_name: HEARTBEAT_EYES },
      { emoji_name: HEARTBEAT_DONE },
    ]);
    expect(post20.map((c) => c.params)).toEqual([
      { emoji_name: HEARTBEAT_EYES },
      { emoji_name: HEARTBEAT_DONE },
    ]);
  });

  test('ack() with empty pending is a no-op', async () => {
    const fake = makeFakeZulipClient();
    const hb = makeHeartbeat(fake);
    await hb.ack();
    expect(fake.calls).toHaveLength(0);
  });

  test('ack() still posts ✅ when DELETE 👀 fails (eg. reaction never landed)', async () => {
    const fake = makeFakeZulipClient({
      'DELETE /messages/42/reactions': () => {
        throw new Error('reaction not found');
      },
    });
    const hb = makeHeartbeat(fake);
    hb.note(42);
    await hb.ack();
    const post = fake.callsTo('/messages/42/reactions', 'POST');
    // 👀 (from note) + ✅ (from ack) — DELETE failure didn't block the ✅.
    expect(post.map((c) => c.params)).toEqual([
      { emoji_name: HEARTBEAT_EYES },
      { emoji_name: HEARTBEAT_DONE },
    ]);
  });

  test('note() failure does not throw to caller (fire-and-forget)', async () => {
    const fake = makeFakeZulipClient({
      'POST /messages/99/reactions': () => {
        throw new Error('zulip down');
      },
    });
    const hb = makeHeartbeat(fake);
    expect(() => hb.note(99)).not.toThrow();
    await Promise.resolve(); // let the rejected promise settle
  });
});
