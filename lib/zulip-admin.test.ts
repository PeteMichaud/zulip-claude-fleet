import { describe, expect, test } from 'bun:test';
import { makeFakeZulipClient } from './zulip-fake.ts';
import {
  createChannelFolder,
  findFolderByName,
  getStreamId,
  listChannelFolders,
  setStreamFolder,
  setStreamPin,
} from './zulip-admin.ts';

describe('getStreamId', () => {
  test('returns stream_id from /get_stream_id', async () => {
    const c = makeFakeZulipClient({
      'GET /get_stream_id': () => ({ result: 'success', stream_id: 42 }),
    });
    expect(await getStreamId(c, 'briefing')).toBe(42);
    expect(c.calls).toEqual([
      { path: '/get_stream_id', method: 'GET', params: { stream: 'briefing' } },
    ]);
  });
});

describe('setStreamPin', () => {
  test('POSTs subscription_data with pin_to_top', async () => {
    const c = makeFakeZulipClient();
    await setStreamPin(c, 7, true);
    expect(c.calls).toEqual([
      {
        path: '/users/me/subscriptions/properties',
        method: 'POST',
        params: {
          subscription_data: [{ stream_id: 7, property: 'pin_to_top', value: true }],
        },
      },
    ]);
  });

  test('passes value=false to unpin', async () => {
    const c = makeFakeZulipClient();
    await setStreamPin(c, 7, false);
    expect((c.calls[0]!.params!.subscription_data as any)[0].value).toBe(false);
  });
});

describe('listChannelFolders', () => {
  test('returns the channel_folders array', async () => {
    const folders = [
      { id: 1, name: 'SFC', description: '', is_archived: false },
      { id: 2, name: 'Personal', description: '', is_archived: false },
    ];
    const c = makeFakeZulipClient({
      'GET /channel_folders': () => ({ result: 'success', channel_folders: folders }),
    });
    expect(await listChannelFolders(c)).toEqual(folders);
  });

  test('returns empty array when key absent', async () => {
    const c = makeFakeZulipClient({
      'GET /channel_folders': () => ({ result: 'success' }),
    });
    expect(await listChannelFolders(c)).toEqual([]);
  });
});

describe('createChannelFolder', () => {
  test('POSTs name + description, returns channel_folder_id', async () => {
    const c = makeFakeZulipClient({
      'POST /channel_folders/create': () => ({ result: 'success', channel_folder_id: 99 }),
    });
    expect(await createChannelFolder(c, 'SFC', 'work stuff')).toBe(99);
    expect(c.calls).toEqual([
      {
        path: '/channel_folders/create',
        method: 'POST',
        params: { name: 'SFC', description: 'work stuff' },
      },
    ]);
  });

  test('description defaults to empty string', async () => {
    const c = makeFakeZulipClient({
      'POST /channel_folders/create': () => ({ result: 'success', channel_folder_id: 1 }),
    });
    await createChannelFolder(c, 'Personal');
    expect(c.calls[0]!.params!.description).toBe('');
  });
});

describe('setStreamFolder', () => {
  test('PATCHes /streams/{id} with folder_id', async () => {
    const c = makeFakeZulipClient();
    await setStreamFolder(c, 11, 5);
    expect(c.calls).toEqual([
      { path: '/streams/11', method: 'PATCH', params: { folder_id: 5 } },
    ]);
  });

  test('passes null to clear folder assignment', async () => {
    const c = makeFakeZulipClient();
    await setStreamFolder(c, 11, null);
    expect(c.calls[0]!.params).toEqual({ folder_id: null });
  });
});

describe('findFolderByName', () => {
  test('matches case-insensitively, skips archived', async () => {
    const c = makeFakeZulipClient({
      'GET /channel_folders': () => ({
        result: 'success',
        channel_folders: [
          { id: 1, name: 'SFC', description: '', is_archived: false },
          { id: 2, name: 'old-sfc', description: '', is_archived: true },
        ],
      }),
    });
    expect(await findFolderByName(c, 'sfc')).toMatchObject({ id: 1, name: 'SFC' });
    expect(await findFolderByName(c, 'old-sfc')).toBeNull();
    expect(await findFolderByName(c, 'nonexistent')).toBeNull();
  });
});
