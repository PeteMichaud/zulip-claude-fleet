#!/usr/bin/env bun
/**
 * Channel server — bridges a Zulip stream to one Claude Code session via MCP.
 * Spawned by Claude as a subprocess when launched with
 * --dangerously-load-development-channels server:zulip-channel and a matching
 * --mcp-config (see shared-mcp.json). See README.md for the project overview.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeZulipClient } from './lib/zulip.ts';
import { chunkMessage } from './lib/chunking.ts';
import { formatPreview } from './lib/format.ts';
import { isDangerousToolCall, PERMISSION_REPLY_RE } from './lib/permission.ts';
import { makeHeartbeat } from './lib/heartbeat.ts';
import { startJsonlActivityWatcher } from './lib/jsonl-tail.ts';
import { appendAllowEntry, derivePattern, matchesAllow } from './lib/allowlist.ts';
import { fetchMessagesSince } from './lib/zulip-catchup.ts';

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


// ---------- Zulip API client ----------
const zulip = makeZulipClient({ site: SITE, email: BOT_EMAIL, apiKey: API_KEY });

// Per-inbound liveness reactions (👀 → 🛠️ → ⌛ → ✓) — see lib/heartbeat.ts.
const heartbeat = makeHeartbeat(zulip, debug);

// Tail Claude's session JSONL so the heartbeat can swap 👀 → 🛠️ when Claude
// is actively writing (tool calls, partial messages) and 🛠️ → ⌛ when it's
// gone quiet for 30s. The JSONL lives at
// <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session>.jsonl — same path the
// dispatcher uses for session_id discovery.
{
  const projectsDir = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude'),
    'projects',
    process.cwd().replaceAll('/', '-'),
  );
  const watcher = startJsonlActivityWatcher({
    projectsDir,
    onActivity: () => {
      heartbeat.bumpActivity();
      claudeIsAlive = true; // also clears the wake-trigger watchdog
    },
    log: debug,
  });
  process.on('SIGTERM', () => watcher.stop());
  process.on('SIGINT', () => watcher.stop());
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
// Tracks the first ListTools call so the wake-trigger replay knows when
// Claude Code is ready to receive channel notifications. See the deferred
// replay block further down. Declared up here so the handler closure doesn't
// reference an uninitialized variable if Claude calls ListTools fast.
let listToolsCalledAt: number | null = null;

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (listToolsCalledAt === null) listToolsCalledAt = Date.now();
  return {
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
};
});

// "Claude is alive and processing" signal for the wake-trigger watchdog.
// Two sources count: a real CallTool from Claude, OR new bytes appearing in
// the session JSONL (Opus extended-thinking turns can run minutes before
// calling any tool — without the JSONL signal, the watchdog falsely declares
// the bot wedged mid-thinking).
let claudeIsAlive = false;

// Tracked so SIGTERM/SIGINT can cancel pending wake-trigger watchdog retries
// before they fire after teardown. Set by replayWakeTriggerIfPresent below.
const wakeWatchdogTimers = new Set<ReturnType<typeof setTimeout>>();

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  claudeIsAlive = true;
  const args = req.params.arguments ?? {};
  if (req.params.name === 'send') return await sendTool(args);
  if (req.params.name === 'read') return await readTool(args);
  throw new Error(`unknown tool: ${req.params.name}`);
});

// MCP tool handler signatures take `Record<string, unknown>` because that's
// what `req.params.arguments` actually carries — the JSON-Schema validation
// on the tool's `inputSchema` runs Claude-side, but the handler still gets
// the unvalidated object. Each tool narrows internally and throws on
// invalid shapes.
async function sendTool(args: Record<string, unknown>) {
  const text = args.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('send: "text" is required and must be a non-empty string');
  }
  const stream = typeof args.stream === 'string' ? args.stream : HOME_STREAM;
  const topic = typeof args.topic === 'string' ? args.topic : DEFAULT_TOPIC;

  const chunks = chunkMessage(text, ZULIP_MSG_LIMIT - 100);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `*(part ${i + 1}/${chunks.length})*\n\n` : '';
    await zulip('/messages', {
      method: 'POST',
      params: { type: 'stream', to: stream, topic, content: prefix + chunks[i] },
    });
  }
  await heartbeat.ack();
  return {
    content: [
      { type: 'text', text: `sent (${chunks.length} message${chunks.length > 1 ? 's' : ''}) to ${stream} > ${topic}` },
    ],
  };
}

async function readTool(args: Record<string, unknown>) {
  const stream = args.stream;
  if (typeof stream !== 'string' || !stream) {
    throw new Error('read: "stream" is required');
  }
  const limit = typeof args.limit === 'number' ? args.limit : READ_DEFAULT;
  const anchor = typeof args.anchor === 'string' ? args.anchor : 'newest';
  const num = Math.min(limit, READ_MAX);
  const data = await zulip('/messages', {
    params: {
      anchor,
      num_before: num,
      num_after: 0,
      narrow: [['stream', stream]],
      apply_markdown: false,
    },
  });
  const formatted = (data.messages as any[])
    .map((m) => `[${new Date(m.timestamp * 1000).toISOString()}] @${m.sender_full_name} (topic: ${m.subject || '-'}): ${m.content}`)
    .join('\n\n');
  return { content: [{ type: 'text', text: formatted || '(no messages)' }] };
}

// ---------- Permission relay ----------
// Map: Zulip message id of the prompt -> Claude's request_id + the original
// tool_name/input_preview, so we can derive an auto-allowlist pattern when
// the operator taps ♾️.
type PendingPermission = {
  request_id: string;
  tool_name: string;
  input_preview: string;
};
const pendingPermissions = new Map<string, PendingPermission>();

// settings.local.json lives under the bot's cwd at this stable relative path
// (cmdCreate scaffolds it on bot creation, dispatcher.ts:801).
const SETTINGS_LOCAL_PATH = '.claude/settings.local.json';

// Runtime allowlist — patterns added via ♾️ during this session. Claude Code
// snapshots its own permissions at session start, so writes to settings.local.json
// only take effect on the next spawn. This in-memory list bypasses that: when a
// fresh permission_request comes in, we check it here BEFORE posting to Zulip,
// and auto-emit allow if any pattern matches. Effective immediately, no reload.
const runtimeAllowlist = new Set<string>();

// Auto mode: dispatcher sets ZULIP_AUTO_APPROVE=1 for bots created/updated
// with --auto. Short-circuits every non-danger permission prompt to allow,
// without ever posting to Zulip. Danger filter still applies — auto mode
// never silently allows `rm -rf`, force-push, sudo, etc. (For full bypass
// including danger, --yolo passes --dangerously-skip-permissions to claude
// at spawn time, in which case the prompt never reaches us.)
const AUTO_APPROVE = process.env.ZULIP_AUTO_APPROVE === '1';
if (AUTO_APPROVE) debug('auto mode: ZULIP_AUTO_APPROVE=1 — non-danger prompts auto-allowed');

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

  const dangerous = isDangerousToolCall(params.tool_name, params.input_preview);

  // Auto mode short-circuit: every non-danger prompt → allow, no Zulip post.
  // Checked before the runtime allowlist so we don't waste cycles iterating.
  if (AUTO_APPROVE && !dangerous) {
    debug('auto-approve:', { tool: params.tool_name, request_id: params.request_id });
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: params.request_id, behavior: 'allow' },
    });
    return;
  }

  // Runtime allowlist: if any pattern from a prior ♾️ tap in this session
  // matches, auto-emit allow without bothering the operator. Bypasses the
  // Zulip prompt entirely. Danger patterns can't be auto-allowed — runtime
  // allows are always overridden by the danger filter.
  if (!dangerous) {
    for (const pattern of runtimeAllowlist) {
      if (matchesAllow(params.tool_name, params.input_preview, pattern)) {
        debug('runtime allowlist hit:', { pattern, request_id: params.request_id });
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: params.request_id, behavior: 'allow' },
        });
        return;
      }
    }
  }

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

  pendingPermissions.set(String(sentMsgId), {
    request_id: params.request_id,
    tool_name: params.tool_name,
    input_preview: params.input_preview,
  });

  if (!dangerous) {
    // Pre-populate reactions for tap-to-approve. Sequential so order is
    // stable: ✅ approve · ❌ deny · ♾️ approve+remember. Concurrent POSTs
    // race and invert muscle memory. Non-fatal if any fails.
    try {
      await zulip(`/messages/${sentMsgId}/reactions`, { method: 'POST', params: { emoji_name: 'check' } });
      await zulip(`/messages/${sentMsgId}/reactions`, { method: 'POST', params: { emoji_name: 'cross_mark' } });
      await zulip(`/messages/${sentMsgId}/reactions`, { method: 'POST', params: { emoji_name: 'infinity' } });
    } catch (err: any) {
      debug('permission relay: pre-react failed (non-fatal):', err.message);
    }
  }
});

async function emitVerdict(requestId: string, behavior: 'allow' | 'deny') {
  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id: requestId, behavior },
  });
  // Clean up pendingPermissions by request_id (reverse lookup; map is small)
  for (const [msgId, p] of pendingPermissions) {
    if (p.request_id === requestId) {
      pendingPermissions.delete(msgId);
      break;
    }
  }
}

// ♾️ tap: approve THIS call, register the pattern in the runtime allowlist
// (matching prompts skip Zulip the rest of this session), AND persist it to
// .claude/settings.local.json so future spawns skip the prompt too.
async function handleAutoAllow(pending: PendingPermission, replyTo: { stream: string; topic: string }): Promise<void> {
  await emitVerdict(pending.request_id, 'allow');

  const pattern = derivePattern(pending.tool_name, pending.input_preview);
  runtimeAllowlist.add(pattern); // mid-session effect, no Claude Code reload

  let body: string;
  try {
    const result = appendAllowEntry(SETTINGS_LOCAL_PATH, pattern);
    if (result.added) {
      body = `♾️ approved + added \`${pattern}\` to allowlist (effective now and on future spawns).`;
      debug('auto-allow: appended', { pattern, request_id: pending.request_id });
    } else {
      body = `♾️ approved (\`${pattern}\` already in allowlist).`;
    }
  } catch (err: any) {
    body = `♾️ approved + auto-allowing \`${pattern}\` for this session, but persisting to settings.local.json failed: ${err.message}`;
    debug('auto-allow: write failed:', err.message);
  }

  zulip('/messages', {
    method: 'POST',
    params: { type: 'stream', to: replyTo.stream, topic: replyTo.topic, content: body },
  }).catch((err: any) => debug('auto-allow: post-back failed (non-fatal):', err.message));
}

// ---------- Connect MCP ----------
await mcp.connect(new StdioServerTransport());
debug('MCP transport connected; capabilities advertised: claude/channel, claude/channel/permission, tools');

// ---------- Wake-trigger replay ----------
// If the dispatcher (phase 2.1+) spawned us, it writes the inbound that woke
// the bot to .wake-trigger.json in cwd before launch. Replay it as a channel
// notification so Claude sees it the same way as a normal Zulip inbound, then
// delete the file. Absent file = normal startup, nothing to replay.
//
// Deferred until Claude Code finishes initial setup. Empirically, sending the
// notification immediately after mcp.connect() returns means Claude doesn't
// receive it — the channel listener isn't fully wired yet on Claude Code's
// side. We defer until after the first ListTools request, which Claude Code
// issues during its post-init tool discovery; by then the channel pipeline is
// live. Belt-and-braces: also defer at least 1s regardless.
//
// Buffer was bumped from 200ms → 1000ms when we hit a `--resume` silent-drop:
// under resume, ListTools fires while Claude is mid-restoration and the
// channel notification arriving 200ms later got dropped before Claude was
// ready to dispatch it. The watchdog inside replayWakeTriggerIfPresent
// catches the residual case where 1s still isn't enough.
const waitForReady = (async () => {
  const deadline = Date.now() + 2000;
  while (listToolsCalledAt === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 1000));
  debug('wake-trigger: ready signal (listToolsCalledAt=' + listToolsCalledAt + ')');
})();
waitForReady.then(replayWakeTriggerIfPresent).catch((err) => debug('wake-trigger: replay failed:', err.message));

async function replayWakeTriggerIfPresent() {
  const path = '.wake-trigger.json';
  if (!existsSync(path)) return;

  let parsed: { stream?: string; topic?: string; sender?: string; content?: string; inbound_message_id?: number };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    debug('wake-trigger: file present but unparseable, leaving in place:', err.message);
    return;
  }

  if (!parsed.content || !parsed.stream) {
    debug('wake-trigger: missing required fields (need content + stream), leaving in place');
    return;
  }

  const topic = parsed.topic || DEFAULT_TOPIC;
  debug('wake-trigger: replaying', { stream: parsed.stream, topic, sender: parsed.sender ?? '' });

  // Match the same lastInbound bookkeeping handleMessage does, so any
  // immediate permission prompt routes back to where the wake came from.
  lastInbound = { stream: parsed.stream, topic };

  if (typeof parsed.inbound_message_id === 'number') {
    heartbeat.note(parsed.inbound_message_id);
  }

  const sendNotification = () => mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: parsed.content!,
      meta: {
        stream: parsed.stream!,
        topic,
        sender: parsed.sender ?? '',
      },
    },
  });

  await sendNotification();

  // --resume silent-drop watchdog: if Claude shows no signs of life within
  // WAKE_RETRY_MS of the replay, the notification was likely dropped during
  // resume restoration. Re-send once.
  //
  // "Signs of life" = claudeIsAlive flag, set by either a CallTool from
  // Claude OR the JSONL tailer noticing new bytes in the session file.
  // CallTool alone false-positives on long Opus extended-thinking turns;
  // the JSONL signal closes that gap.
  //
  // Timer handles tracked so SIGTERM/SIGINT can cancel them; otherwise the
  // callbacks fire after process exit (or worse, after the channel server
  // tears down but before Bun reaps the process).
  const WAKE_RETRY_MS = 10_000;
  const retry = setTimeout(async () => {
    wakeWatchdogTimers.delete(retry);
    if (claudeIsAlive) return;
    debug('wake-trigger: watchdog tripped (no Claude activity in 10s); resending notification');
    try {
      await sendNotification();
    } catch (err: any) {
      debug('wake-trigger: resend failed:', err.message);
      return;
    }
    const followup = setTimeout(() => {
      wakeWatchdogTimers.delete(followup);
      if (claudeIsAlive) return;
      debug('wake-trigger: ERROR — still no Claude activity 10s after resend; bot is wedged. Operator should `reset` it.');
    }, WAKE_RETRY_MS);
    wakeWatchdogTimers.add(followup);
  }, WAKE_RETRY_MS);
  wakeWatchdogTimers.add(retry);

  // The file isn't needed anymore — watchdog retries use the in-memory
  // parsed object. Unlink so a future spawn doesn't replay stale content.
  try {
    unlinkSync(path);
  } catch (err: any) {
    debug('wake-trigger: failed to unlink after replay (non-fatal):', err.message);
  }
}

// ---------- Zulip event queue ----------
let queueId: string | undefined;
let lastEventId = -1;
// Bookmark of the highest msg.id we've successfully handed off to Claude.
// Distinct from lastEventId (queue events live in a different namespace and
// die with the queue). Used by the catch-up fetch on re-register to recover
// owner messages that arrived during the gap.
let lastHandledMessageId = 0;

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

// Accept messages from the operator (always) and from the dispatcher's
// own bot identity (when DISPATCH_BOT_USER_ID is set in env). The latter
// lets the dispatcher relay inter-bot @-mention forwards to us.
const ALLOWED_SENDER_IDS = new Set<number>([OWNER_USER_ID]);
{
  const raw = process.env.DISPATCH_BOT_USER_ID;
  if (raw) {
    const id = parseInt(raw, 10);
    if (Number.isFinite(id)) ALLOWED_SENDER_IDS.add(id);
  }
}

async function handleMessage(event: any) {
  const msg = event.message;
  if (!ALLOWED_SENDER_IDS.has(msg.sender_id)) return; // sender gate

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
  if (typeof msg.id === 'number') heartbeat.note(msg.id);
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
  const pending = pendingPermissions.get(msgId);
  if (!pending) return;

  if (event.emoji_name === 'infinity') {
    debug('reaction verdict: ♾️ auto-allow', { request_id: pending.request_id });
    await handleAutoAllow(pending, lastInbound);
    return;
  }

  const verdict =
    event.emoji_name === 'check' ? 'allow' :
    event.emoji_name === 'cross_mark' ? 'deny' :
    null;
  if (!verdict) return;

  debug('reaction verdict:', { request_id: pending.request_id, behavior: verdict, emoji: event.emoji_name });
  await emitVerdict(pending.request_id, verdict);
}

await registerQueue();

// ---------- Main event loop ----------
let running = true;
const shutdown = () => {
  running = false;
  for (const t of wakeWatchdogTimers) clearTimeout(t);
  wakeWatchdogTimers.clear();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function dispatchMessageEvent(event: any): Promise<void> {
  await handleMessage(event);
  const msgId = event?.message?.id;
  if (typeof msgId === 'number' && msgId > lastHandledMessageId) {
    lastHandledMessageId = msgId;
  }
}

// After re-registering (queue death), fetch any messages that arrived in the
// gap and replay them through handleMessage. Reactions buffered on the dying
// queue are gone — they're ephemeral signal anyway. Bookmark advances inside
// dispatchMessageEvent so successive re-registers don't re-replay.
async function catchUpMissedMessages(): Promise<void> {
  if (lastHandledMessageId === 0) return;
  let missed: any[];
  try {
    missed = await fetchMessagesSince({
      zulip,
      sinceMessageId: lastHandledMessageId,
      narrow: [['stream', HOME_STREAM]],
    });
  } catch (err: any) {
    debug(`catch-up fetch failed (proceeding without): ${err.message}`);
    return;
  }
  if (missed.length === 0) return;
  debug(`replaying ${missed.length} missed messages since msg ${lastHandledMessageId}`);
  for (const message of missed) {
    try {
      await dispatchMessageEvent({ message });
    } catch (err: any) {
      debug(`catch-up replay error on msg ${message.id}: ${err.message}`);
    }
  }
}

while (running) {
  try {
    const data = await zulip('/events', {
      params: { queue_id: queueId!, last_event_id: lastEventId },
    });
    for (const event of data.events) {
      lastEventId = Math.max(lastEventId, event.id);
      try {
        if (event.type === 'message') await dispatchMessageEvent(event);
        else if (event.type === 'reaction') await handleReaction(event);
      } catch (err: any) {
        console.error('event handler error:', err.message);
      }
    }
  } catch (err: any) {
    if (String(err.message).includes('BAD_EVENT_QUEUE_ID')) {
      console.error('zulip-channel: event queue expired, re-registering');
      await registerQueue().then(catchUpMissedMessages).catch((e) => {
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
