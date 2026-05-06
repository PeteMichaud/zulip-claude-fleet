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
mkdirSync(STATE_DIR, { recursive: true });

// ---------- Logging ----------

function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`;
  console.log(line);
}

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

  // Update last_active state.
  const state = readState(bot.name);
  state.last_active = new Date().toISOString();
  writeState(state);

  // TODO step 4: check if bot's Claude is running; if not, spawn it (with
  //   wake-trigger written to bot.cwd/.wake-trigger.json before launch).
  //   For 2.1 step 3 (skeleton) we just log.
}

// ---------- Main loop ----------

await registerQueue();

let running = true;
const shutdown = (sig: string) => {
  log(`received ${sig}, shutting down`);
  running = false;
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

while (running) {
  try {
    const data = await zulip('/events', {
      params: { queue_id: queueId!, last_event_id: lastEventId },
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
