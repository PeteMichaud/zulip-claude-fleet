// Zulip admin/user helpers used by dispatcher commands. All take a ZulipClient
// so callers control auth: pin/unpin and folder ops want owner creds (the
// /bots and /channel_folders endpoints reject bot callers, and pin_to_top is
// always per-user — set on whichever account owns the API key).

import type { ZulipClient } from './zulip.ts';

export type ChannelFolder = {
  id: number;
  name: string;
  description: string;
  is_archived: boolean;
};

export async function getStreamId(client: ZulipClient, name: string): Promise<number> {
  const res = await client('/get_stream_id', { params: { stream: name } });
  return res.stream_id as number;
}

export async function setStreamPin(
  client: ZulipClient,
  streamId: number,
  value: boolean,
): Promise<void> {
  await client('/users/me/subscriptions/properties', {
    method: 'POST',
    params: {
      subscription_data: [{ stream_id: streamId, property: 'pin_to_top', value }],
    },
  });
}

export async function listChannelFolders(client: ZulipClient): Promise<ChannelFolder[]> {
  const res = await client('/channel_folders');
  return (res.channel_folders ?? []) as ChannelFolder[];
}

export async function createChannelFolder(
  client: ZulipClient,
  name: string,
  description = '',
): Promise<number> {
  const res = await client('/channel_folders/create', {
    method: 'POST',
    params: { name, description },
  });
  return res.channel_folder_id as number;
}

export async function setStreamFolder(
  client: ZulipClient,
  streamId: number,
  folderId: number | null,
): Promise<void> {
  await client(`/streams/${streamId}`, {
    method: 'PATCH',
    params: { folder_id: folderId },
  });
}

// Resolve a folder name to its id. Returns null if no folder by that name
// exists; the caller decides whether to error or auto-create.
export async function findFolderByName(
  client: ZulipClient,
  name: string,
): Promise<ChannelFolder | null> {
  const folders = await listChannelFolders(client);
  const lower = name.toLowerCase();
  return folders.find((f) => f.name.toLowerCase() === lower && !f.is_archived) ?? null;
}
