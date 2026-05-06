#!/usr/bin/env bun
/**
 * Zulip ↔ Claude Code Channel — phase 1 implementation.
 * See SPEC.md for the design; RUNBOOK.md for how to run it.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { appendFileSync } from 'node:fs';

// ---------- Debug log ----------
// stderr from MCP servers goes somewhere we can't easily find;
// tail /tmp/zulip-channel.log to see what's happening live.
const LOG_FILE = '/tmp/zulip-channel.log';
function debug(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`;
  try { appendFileSync(LOG_FILE, line); } catch { /* non-fatal */ }
  console.error(line.trimEnd());
}

// ---------- Config ----------
const SITE = mustEnv('ZULIP_SITE');
const BOT_EMAIL = mustEnv('ZULIP_BOT_EMAIL');
const API_KEY = mustEnv('ZULIP_API_KEY');
const HOME_STREAM = mustEnv('ZULIP_HOME_STREAM');
const OWNER_USER_ID = parseInt(mustEnv('ZULIP_OWNER_USER_ID'), 10);

const ZULIP_MSG_LIMIT = 10000;
const READ_DEFAULT = 50;
const READ_MAX = 200;
const DEFAULT_TOPIC = 'chat';

// Where permission prompts get posted. Updated on each inbound message from
// the owner so prompts appear inline with the active conversation.
let lastInbound: { stream: string; topic: string } = { stream: HOME_STREAM, topic: DEFAULT_TOPIC };

// Patterns that bypass the tap-to-approve path and require typed verdicts.
// Checked against `${tool_name} ${input_preview}`.
const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /--force-with-lease\b/i,
  /\bcurl\b[^|]*\|\s*sh\b/i,
  /\bsudo\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
];

// ---------- Zulip API helper ----------
const ZAUTH = 'Basic ' + Buffer.from(`${BOT_EMAIL}:${API_KEY}`).toString('base64');

async function zulip(
  path: string,
  opts: { method?: string; params?: Record<string, unknown> } = {},
): Promise<any> {
  const method = opts.method ?? 'GET';
  const url = new URL(`/api/v1${path}`, SITE);
  const init: RequestInit = { method, headers: { Authorization: ZAUTH } };

  if (opts.params) {
    if (method === 'GET') {
      for (const [k, v] of Object.entries(opts.params)) {
        url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    } else {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.params)) {
        body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      init.body = body;
      init.headers = {
        ...init.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      };
    }
  }

  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as any).result !== 'success') {
    throw new Error(`Zulip ${method} ${path} failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------- Startup credential validation ----------
let me: any;
debug('startup: pid=' + process.pid + ' bun=' + (process.versions as any).bun);
try {
  me = await zulip('/users/me');
} catch (err: any) {
  debug('FATAL: Zulip credentials rejected or site unreachable.', err.message);
  process.exit(1);
}
debug(`auth ok: ${me.email} (bot user_id ${me.user_id}); home stream ${HOME_STREAM}; owner ${OWNER_USER_ID}`);

// ---------- MCP server ----------
const mcp = new Server(
  { name: 'zulip-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      `You are reachable via the Zulip stream "${HOME_STREAM}". Inbound messages from your operator arrive as <channel source="zulip-channel" stream="..." topic="..." sender="..."> tags.`,
      `To reply, call the "send" tool. By default reply to the same stream and topic as the inbound tag — only set "stream" or "topic" explicitly when you want to deviate.`,
      `Use the "read" tool to fetch recent messages from any stream when you need context that isn't in your conversation.`,
      `Long replies are chunked automatically; don't try to hand-chunk.`,
    ].join(' '),
  },
);

// ---------- Tools ----------
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send',
      description: 'Send a message to a Zulip stream. Defaults to the home stream and the "chat" topic.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message body. Markdown supported.' },
          stream: { type: 'string', description: `Stream name (default: "${HOME_STREAM}").` },
          topic: { type: 'string', description: `Topic within the stream (default: "${DEFAULT_TOPIC}").` },
        },
        required: ['text'],
      },
    },
    {
      name: 'read',
      description: 'Fetch recent messages from a Zulip stream. Returns formatted text (timestamp, sender, content per message).',
      inputSchema: {
        type: 'object',
        properties: {
          stream: { type: 'string', description: 'Stream name to read from.' },
          limit: { type: 'number', description: `How many messages (default ${READ_DEFAULT}, max ${READ_MAX}).` },
          anchor: { type: 'string', description: 'Anchor: "newest" (default), "oldest", or a message id.' },
        },
        required: ['stream'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  if (req.params.name === 'send') return await sendTool(args);
  if (req.params.name === 'read') return await readTool(args);
  throw new Error(`unknown tool: ${req.params.name}`);
});

async function sendTool(args: { text: string; stream?: string; topic?: string }) {
  if (typeof args.text !== 'string' || args.text.length === 0) {
    throw new Error('send: "text" is required and must be a non-empty string');
  }
  const stream = args.stream ?? HOME_STREAM;
  const topic = args.topic ?? DEFAULT_TOPIC;

  const chunks = chunkMessage(args.text, ZULIP_MSG_LIMIT - 100);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `*(part ${i + 1}/${chunks.length})*\n\n` : '';
    await zulip('/messages', {
      method: 'POST',
      params: { type: 'stream', to: stream, topic, content: prefix + chunks[i] },
    });
  }
  return {
    content: [
      { type: 'text', text: `sent (${chunks.length} message${chunks.length > 1 ? 's' : ''}) to ${stream} > ${topic}` },
    ],
  };
}

async function readTool(args: { stream: string; limit?: number; anchor?: string }) {
  if (typeof args.stream !== 'string' || !args.stream) {
    throw new Error('read: "stream" is required');
  }
  const num = Math.min(args.limit ?? READ_DEFAULT, READ_MAX);
  const data = await zulip('/messages', {
    params: {
      anchor: args.anchor ?? 'newest',
      num_before: num,
      num_after: 0,
      narrow: [['stream', args.stream]],
      apply_markdown: false,
    },
  });
  const formatted = (data.messages as any[])
    .map((m) => `[${new Date(m.timestamp * 1000).toISOString()}] @${m.sender_full_name} (topic: ${m.subject || '-'}): ${m.content}`)
    .join('\n\n');
  return { content: [{ type: 'text', text: formatted || '(no messages)' }] };
}

function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen; // no good break, hard-cut
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ---------- Permission relay ----------
// Map: Zulip message id of the prompt -> Claude's request_id
const pendingPermissions = new Map<string, string>();

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  debug('permission_request:', { id: params.request_id, tool: params.tool_name, desc: params.description });
  const haystack = `${params.tool_name} ${params.input_preview}`;
  const dangerous = DANGER_PATTERNS.some((p) => p.test(haystack));

  const header = dangerous
    ? `⚠️ **${params.tool_name}** · \`${params.request_id}\` · typed verdict only`
    : `🔒 **${params.tool_name}** · \`${params.request_id}\``;

  const preview = params.input_preview.length > 0
    ? '\n' + formatPreview(params.input_preview)
    : '';

  const body = `${header}${preview}`;

  let sentMsgId: number;
  try {
    const sent = await zulip('/messages', {
      method: 'POST',
      params: { type: 'stream', to: lastInbound.stream, topic: lastInbound.topic, content: body },
    });
    sentMsgId = sent.id;
    debug(`posted permission prompt: msg_id=${sentMsgId} dangerous=${dangerous} where=${lastInbound.stream}/${lastInbound.topic}`);
  } catch (err: any) {
    debug('permission relay: failed to post prompt:', err.message);
    return; // Claude Code's local dialog still works; we just couldn't relay
  }

  pendingPermissions.set(String(sentMsgId), params.request_id);

  if (!dangerous) {
    // Pre-populate reactions for tap-to-approve. Non-fatal if it fails.
    await Promise.all([
      zulip(`/messages/${sentMsgId}/reactions`, { method: 'POST', params: { emoji_name: 'check' } }),
      zulip(`/messages/${sentMsgId}/reactions`, { method: 'POST', params: { emoji_name: 'cross_mark' } }),
    ]).catch((err) => debug('permission relay: pre-react failed (non-fatal):', err.message));
  }
});

// Render the tool's input_preview as wrapping key-value pairs.
// Zulip code fences don't soft-wrap, so a long single-line JSON gets horizontally
// truncated. Inline code (single backticks) wraps on whitespace, so we render
// each key as bold and each value as inline code on its own line. Falls back to
// raw inline code if input_preview isn't parseable JSON (e.g. truncated mid-string).
function formatPreview(s: string): string {
  try {
    const obj = JSON.parse(s);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return `\`${s.replace(/`/g, "'")}\``;
    }
    return Object.entries(obj)
      .map(([k, v]) => {
        const raw = typeof v === 'string' ? v : JSON.stringify(v);
        const safe = raw.replace(/`/g, "'");
        return `**${k}**: \`${safe}\``;
      })
      .join('\n');
  } catch {
    return `\`${s.replace(/`/g, "'")}\``;
  }
}

async function emitVerdict(requestId: string, behavior: 'allow' | 'deny') {
  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id: requestId, behavior },
  });
  // Clean up pendingPermissions by request_id (reverse lookup; map is small)
  for (const [msgId, rid] of pendingPermissions) {
    if (rid === requestId) {
      pendingPermissions.delete(msgId);
      break;
    }
  }
}

// ---------- Connect MCP ----------
await mcp.connect(new StdioServerTransport());
debug('MCP transport connected; capabilities advertised: claude/channel, claude/channel/permission, tools');

// ---------- Zulip event queue ----------
let queueId: string | undefined;
let lastEventId = -1;

async function registerQueue() {
  const data = await zulip('/register', {
    method: 'POST',
    params: {
      event_types: ['message', 'reaction'],
      narrow: [['stream', HOME_STREAM]],
      apply_markdown: false,
      slim_presence: true,
    },
  });
  queueId = data.queue_id;
  lastEventId = data.last_event_id;
  debug('event queue registered:', queueId);
}

// `yes abcde` / `no abcde` (case-insensitive, tolerates phone autocorrect)
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

async function handleMessage(event: any) {
  const msg = event.message;
  if (msg.sender_id !== OWNER_USER_ID) return; // sender gate

  const text: string = msg.content;

  // Typed permission verdict?
  const m = PERMISSION_REPLY_RE.exec(text);
  if (m) {
    const verdict = m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny';
    const requestId = m[2].toLowerCase();
    await emitVerdict(requestId, verdict);
    return;
  }

  // Otherwise forward as channel event, and remember where this came from so
  // permission prompts post into the same topic.
  const stream = typeof msg.display_recipient === 'string' ? msg.display_recipient : HOME_STREAM;
  const topic = msg.subject || DEFAULT_TOPIC;
  lastInbound = { stream, topic };
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: { stream, topic, sender: msg.sender_full_name ?? '' },
    },
  });
}

async function handleReaction(event: any) {
  if (event.op !== 'add') return;
  if (event.user_id !== OWNER_USER_ID) return;
  const msgId = String(event.message_id);
  const requestId = pendingPermissions.get(msgId);
  if (!requestId) return;

  const verdict =
    event.emoji_name === 'check' ? 'allow' :
    event.emoji_name === 'cross_mark' ? 'deny' :
    null;
  if (!verdict) return;

  debug('reaction verdict:', { request_id: requestId, behavior: verdict, emoji: event.emoji_name });
  await emitVerdict(requestId, verdict);
}

await registerQueue();

// ---------- Main event loop ----------
let running = true;
const shutdown = () => { running = false; };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

while (running) {
  try {
    const data = await zulip('/events', {
      params: { queue_id: queueId!, last_event_id: lastEventId },
    });
    for (const event of data.events) {
      lastEventId = Math.max(lastEventId, event.id);
      try {
        if (event.type === 'message') await handleMessage(event);
        else if (event.type === 'reaction') await handleReaction(event);
      } catch (err: any) {
        console.error('event handler error:', err.message);
      }
    }
  } catch (err: any) {
    if (String(err.message).includes('BAD_EVENT_QUEUE_ID')) {
      console.error('zulip-channel: event queue expired, re-registering');
      await registerQueue().catch((e) => {
        console.error('zulip-channel: re-register failed, retrying in 5s:', e.message);
        return new Promise((r) => setTimeout(r, 5000));
      });
    } else if (running) {
      console.error('zulip-channel: event poll error, retrying in 2s:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

console.error('zulip-channel: shutting down');
process.exit(0);

// ---------- Helpers ----------
function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`FATAL: missing env var ${key} (check .env)`);
    process.exit(1);
  }
  return v;
}
