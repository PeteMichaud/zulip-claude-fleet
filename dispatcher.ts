#!/usr/bin/env bun
/**
 * Phase 2.1 dispatcher — wake-up only.
 *
 * For now this is a SKELETON: it subscribes to Zulip for the registered
 * bot's home stream and logs inbound messages from the owner. Spawning
 * Claude on those inbounds (the actual wake-up) lands in step 4.
 *
 * See PHASE-2.1.md for the broader design.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Subprocess = ReturnType<typeof Bun.spawn>;
type WakeTrigger = { stream: string; topic: string; sender: string; content: string };

// ---------- Config ----------

const SITE = mustEnv('ZULIP_SITE');
const BOT_EMAIL = mustEnv('ZULIP_BOT_EMAIL');
const API_KEY = mustEnv('ZULIP_API_KEY');
const OWNER_USER_ID = parseInt(mustEnv('ZULIP_OWNER_USER_ID'), 10);

// Hardcoded registry for 2.1. Multi-bot lands in 2.4.
type Bot = { name: string; home_stream: string; cwd: string };
const REGISTRY: Record<string, Bot> = {
  briefing: {
    name: 'briefing',
    home_stream: 'briefing',
    cwd: '/Users/pete/claude-fleet/briefing',
  },
};

const STATE_DIR = join(import.meta.dir, 'state');
const LOG_DIR = join(STATE_DIR, 'logs');
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const SHARED_MCP_CONFIG = join(import.meta.dir, 'shared-mcp.json');
const PTY_HELPER = join(import.meta.dir, 'scripts', 'pty-helper.py');
const CLAUDE_CONFIG_DIR_DEFAULT = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude-sfc');

// ---------- Logging ----------

function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`;
  console.log(line);
}

// ---------- Zulip API helper ----------

const ZAUTH = 'Basic ' + Buffer.from(`${BOT_EMAIL}:${API_KEY}`).toString('base64');

async function zulip(
  path: string,
  opts: { method?: string; params?: Record<string, unknown>; signal?: AbortSignal } = {},
): Promise<any> {
  const method = opts.method ?? 'GET';
  const url = new URL(`/api/v1${path}`, SITE);
  const init: RequestInit = { method, headers: { Authorization: ZAUTH }, signal: opts.signal };

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
      init.headers = { ...init.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
    }
  }

  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as any).result !== 'success') {
    throw new Error(`Zulip ${method} ${path} failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// ---------- Per-bot state ----------

type BotState = {
  name: string;
  last_active: string | null;
  session_id: string | null;
  broken: string | null; // failure reason if cred-rejected at spawn time
};

function statePath(botName: string) {
  return join(STATE_DIR, `${botName}.json`);
}

function readState(botName: string): BotState {
  const path = statePath(botName);
  if (!existsSync(path)) {
    return { name: botName, last_active: null, session_id: null, broken: null };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err: any) {
    log(`state for ${botName} unreadable, treating as empty:`, err.message);
    return { name: botName, last_active: null, session_id: null, broken: null };
  }
}

function writeState(state: BotState) {
  const path = statePath(state.name);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, path); // atomic-ish on POSIX same-fs
}

// ---------- Startup auth check ----------

log('dispatcher starting');

let me: any;
try {
  me = await zulip('/users/me');
} catch (err: any) {
  log('FATAL: Zulip auth failed at startup:', err.message);
  process.exit(1);
}
log(`auth ok: ${me.email} (user_id ${me.user_id}); registered bots: [${Object.keys(REGISTRY).join(', ')}]`);

// ---------- Zulip event queue ----------

let queueId: string | undefined;
let lastEventId = -1;

async function registerQueue() {
  const streams = Object.values(REGISTRY).map((b) => b.home_stream);
  if (streams.length !== 1) {
    // Multi-stream narrows aren't a single OR'd narrow in Zulip — would need
    // either no narrow + client-side filtering, or one queue per stream.
    // 2.1 is single-bot, so this is fine; revisit in 2.4.
    throw new Error(`registry must have exactly one bot in 2.1, got ${streams.length}`);
  }
  const data = await zulip('/register', {
    method: 'POST',
    params: {
      event_types: ['message'],
      narrow: [['stream', streams[0]]],
      apply_markdown: false,
    },
  });
  queueId = data.queue_id;
  lastEventId = data.last_event_id;
  log(`event queue registered: ${queueId} (narrowed to stream "${streams[0]}")`);
}

// ---------- Process supervision ----------

// We spawn Claude through scripts/pty-helper.py rather than directly. Claude
// Code refuses to start without a TTY, and none of the obvious shortcuts
// reliably give us one from a Bun.spawn parent: stdio: 'pipe' is a socket
// pair (fails ioctl/tcgetattr); macOS BSD `script` chokes on socket stdin;
// node-pty hits posix_spawnp errors on this macOS version under both Bun
// and Node. Python's stdlib `pty.spawn` works cleanly. The helper allocates
// a master/slave pair, shuttles bytes between the parent's pipes and the
// child's PTY, and forwards the exit code.
const runningBots = new Map<string, Subprocess>();
const spawnLocks = new Map<string, Promise<unknown>>();

function isAlive(botName: string): boolean {
  const child = runningBots.get(botName);
  if (!child) return false;
  if (child.exitCode !== null) {
    runningBots.delete(botName);
    return false;
  }
  return true;
}

async function spawnBot(bot: Bot, trigger: WakeTrigger): Promise<void> {
  // Write wake-trigger first so the channel server picks it up at startup.
  const wakeTriggerPath = join(bot.cwd, '.wake-trigger.json');
  writeFileSync(wakeTriggerPath, JSON.stringify(trigger, null, 2) + '\n');

  const logPath = join(LOG_DIR, `${bot.name}.log`);
  const logFile = Bun.file(logPath);
  const logWriter = logFile.writer();
  logWriter.write(`\n--- spawn at ${new Date().toISOString()} ---\n`);
  try { await logWriter.flush(); } catch { /* non-fatal */ }

  const child = Bun.spawn({
    cmd: [
      'python3', PTY_HELPER,
      'claude',
      '--dangerously-load-development-channels', 'server:zulip-channel',
      '--mcp-config', SHARED_MCP_CONFIG,
    ],
    cwd: bot.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: CLAUDE_CONFIG_DIR_DEFAULT,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  log(`spawned @${bot.name}: pid=${child.pid} cwd=${bot.cwd}`);
  runningBots.set(bot.name, child);

  // Pump child stdout + stderr to the per-bot log. Any error in the pump
  // (e.g. stream closed during shutdown) is non-fatal.
  const pumpStream = async (stream: ReadableStream<Uint8Array>, label: string) => {
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) logWriter.write(value);
      }
    } catch (err: any) {
      log(`@${bot.name} ${label} pump error: ${err.message}`);
    }
  };
  pumpStream(child.stdout as ReadableStream<Uint8Array>, 'stdout').catch(() => { /* swallowed */ });
  pumpStream(child.stderr as ReadableStream<Uint8Array>, 'stderr').catch(() => { /* swallowed */ });

  // Watch for exit and clean up. .catch defends against unhandled rejection
  // in the .then callback (which would otherwise crash the dispatcher).
  child.exited.then(async (exitCode) => {
    runningBots.delete(bot.name);
    log(`@${bot.name} exited (code ${exitCode})`);
    try {
      await logWriter.flush();
      logWriter.end();
    } catch { /* non-fatal */ }
  }).catch((err) => log(`@${bot.name} exit handler error: ${err.message}`));

  // First launch with --dangerously-load-development-channels shows a
  // confirmation menu ("1. I am using this for local development / 2. Exit"),
  // with option 1 pre-selected. Send Enter after a brief delay to dismiss.
  // stdin stays open so Claude doesn't see EOF.
  const enc = new TextEncoder();
  setTimeout(() => {
    if (!isAlive(bot.name)) return;
    try {
      child.stdin?.write(enc.encode('\r'));
      log(`@${bot.name}: sent Enter to dismiss --dangerously confirmation`);
    } catch (err: any) {
      log(`@${bot.name}: failed to send Enter: ${err.message}`);
    }
  }, 2000);
}

async function maybeSpawn(bot: Bot, trigger: WakeTrigger): Promise<void> {
  // Serialize spawn attempts per bot. If a previous spawn is in flight,
  // wait for it; the second caller may then find the bot already alive.
  const previous = spawnLocks.get(bot.name);
  let releaseLock!: () => void;
  const lock = new Promise<void>((r) => { releaseLock = r; });
  spawnLocks.set(bot.name, previous ? previous.then(() => lock) : lock);
  if (previous) await previous;

  try {
    if (isAlive(bot.name)) {
      log(`@${bot.name} already alive; not respawning (its own MCP will handle this inbound)`);
      return;
    }
    await spawnBot(bot, trigger);
  } catch (err: any) {
    log(`@${bot.name} spawn failed: ${err.message}`);
    // TODO 2.2: post into @dispatch ops stream and mark broken in state.
  } finally {
    releaseLock();
  }
}

// ---------- Inbound handler ----------

function botForStream(stream: string): Bot | undefined {
  return Object.values(REGISTRY).find((b) => b.home_stream === stream);
}

async function handleMessage(event: any) {
  const msg = event.message;
  if (msg.sender_id !== OWNER_USER_ID) return; // only owner messages count

  const stream = typeof msg.display_recipient === 'string' ? msg.display_recipient : '';
  const bot = botForStream(stream);
  if (!bot) {
    log(`inbound in unregistered stream "${stream}", ignoring`);
    return;
  }

  const snippet = (msg.content ?? '').slice(0, 100).replace(/\n/g, ' ');
  log(`inbound for @${bot.name}: topic="${msg.subject ?? ''}" sender="${msg.sender_full_name ?? ''}" content=${JSON.stringify(snippet)}`);

  const state = readState(bot.name);
  state.last_active = new Date().toISOString();
  writeState(state);

  if (isAlive(bot.name)) {
    // Bot's own channel MCP will receive this same event from its own queue.
    // Dispatcher does nothing.
    return;
  }

  // Bot is sleeping — wake it. Pass this message as the bootstrap.
  const trigger: WakeTrigger = {
    stream,
    topic: msg.subject || 'chat',
    sender: msg.sender_full_name ?? '',
    content: msg.content ?? '',
  };
  await maybeSpawn(bot, trigger);
}

// ---------- Main loop ----------

await registerQueue();

let running = true;
let shuttingDown = false;
const pollAbort = new AbortController();

const shutdown = (sig: string) => {
  if (shuttingDown) return; // idempotent: ignore repeated Ctrl+C
  shuttingDown = true;
  log(`received ${sig}, shutting down`);
  running = false;
  pollAbort.abort(); // cancels the in-flight long-poll so the loop exits promptly
  for (const [name, child] of runningBots) {
    log(`terminating @${name} (pid ${child.pid})`);
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

while (running) {
  try {
    const data = await zulip('/events', {
      params: { queue_id: queueId!, last_event_id: lastEventId },
      signal: pollAbort.signal,
    });
    for (const event of data.events) {
      lastEventId = Math.max(lastEventId, event.id);
      try {
        if (event.type === 'message') await handleMessage(event);
      } catch (err: any) {
        log('handler error:', err.message);
      }
    }
  } catch (err: any) {
    // Shutdown aborts the fetch; let the loop fall through to exit.
    if (err.name === 'AbortError' || !running) break;
    if (String(err.message).includes('BAD_EVENT_QUEUE_ID')) {
      log('event queue expired; re-registering');
      try {
        await registerQueue();
      } catch (e: any) {
        log('re-register failed, retrying in 5s:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    } else if (running) {
      log('event poll error, retrying in 2s:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

log('dispatcher exited');

// ---------- Helpers ----------

function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`FATAL: missing env var ${key} (check .env)`);
    process.exit(1);
  }
  return v;
}
