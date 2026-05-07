#!/usr/bin/env bun
/**
 * Dispatcher — fleet supervisor and Zulip command handler.
 *
 * Operates under @dispatch-bot's identity. Single Zulip event queue gets
 * messages from every stream dispatch-bot is subscribed to (#Dispatch and
 * each registered bot's home stream); handleMessage routes by stream:
 *   - #Dispatch: parse fleet-ops commands (spin up, shut down, list, etc.)
 *   - bot home stream: wake-up trigger if the bot is sleeping
 *
 * Spawned bots are children of this process, supervised via Bun.Subprocess.
 * Per-bot creds in REGISTRY are injected into each spawn's env so the
 * channel server authenticates as that bot, not as dispatch-bot.
 *
 * See SPEC.md for the broader design and PHASE-2.1.md for the build notes.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeZulipClient } from './lib/zulip.ts';
import { parseCommand } from './lib/commands.ts';
import { humanDuration } from './lib/format.ts';

type Subprocess = ReturnType<typeof Bun.spawn>;
type WakeTrigger = { stream: string; topic: string; sender: string; content: string };

// ---------- Config ----------

const SITE = mustEnv('ZULIP_SITE');
const OWNER_USER_ID = parseInt(mustEnv('ZULIP_OWNER_USER_ID'), 10);

// The dispatcher operates under @dispatch-bot's identity. Its event queue
// gets messages from every stream dispatch-bot is subscribed to (its own
// home stream + every bot's home stream).
const DISPATCH_BOT_EMAIL = mustEnv('DISPATCH_BOT_EMAIL');
const DISPATCH_BOT_API_KEY = mustEnv('DISPATCH_BOT_API_KEY');
const DISPATCH_STREAM = mustEnv('DISPATCH_STREAM');

// Per-bot record. `bot_email` / `bot_api_key` are the credentials *that bot's*
// channel server uses (injected at spawn time), distinct from dispatch-bot.
type Bot = {
  name: string;
  home_stream: string;
  cwd: string;
  bot_email: string;
  bot_api_key: string;
};

// Hardcoded registry for 2.2. Multi-bot lands in 2.4.
const REGISTRY: Record<string, Bot> = {
  briefing: {
    name: 'briefing',
    home_stream: 'briefing',
    cwd: '/Users/pete/claude-fleet/briefing',
    bot_email: mustEnv('ZULIP_BOT_EMAIL'),
    bot_api_key: mustEnv('ZULIP_API_KEY'),
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

// ---------- Zulip API client ----------

const zulip = makeZulipClient({
  site: SITE,
  email: DISPATCH_BOT_EMAIL,
  apiKey: DISPATCH_BOT_API_KEY,
});

// ---------- Session-storage discovery ----------

// Claude Code stores session jsonls at:
//   $CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl
// where the encoding is just every '/' in the absolute path replaced with '-'.
// Capturing the latest session_id after a bot exits lets us pass it to
// `claude --resume <id>` on the next spawn, preserving the bot's working
// memory across sleep/wake cycles.

function encodeCwd(absPath: string): string {
  return absPath.replaceAll('/', '-');
}

function latestSessionId(claudeConfigDir: string, botCwd: string): string | null {
  const dir = join(claudeConfigDir, 'projects', encodeCwd(botCwd));
  if (!existsSync(dir)) return null;
  let latest: { name: string; mtime: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const m = statSync(join(dir, f)).mtimeMs;
      if (latest === null || m > latest.mtime) latest = { name: f, mtime: m };
    } catch {
      /* skip unreadable entries */
    }
  }
  return latest ? latest.name.replace(/\.jsonl$/, '') : null;
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
  // No stream narrow: dispatch-bot is subscribed to its own stream + every
  // bot's home stream, so its queue gets exactly the messages we care about.
  // Stream-based routing happens in handleMessage.
  const data = await zulip('/register', {
    method: 'POST',
    params: {
      event_types: ['message'],
      apply_markdown: false,
    },
  });
  queueId = data.queue_id;
  lastEventId = data.last_event_id;
  log(`event queue registered: ${queueId}`);
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
const startTimes = new Map<string, number>(); // botName -> ms timestamp at spawn

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

  // Resume the bot's prior session if we know about one; otherwise start fresh.
  // session_id was captured at the previous exit (see child.exited handler below).
  const priorState = readState(bot.name);
  const cmd: string[] = ['python3', PTY_HELPER, 'claude'];
  if (priorState.session_id) {
    cmd.push('--resume', priorState.session_id);
    log(`@${bot.name}: resuming session ${priorState.session_id}`);
  } else {
    log(`@${bot.name}: no prior session_id — starting fresh`);
  }
  cmd.push(
    '--dangerously-load-development-channels', 'server:zulip-channel',
    '--mcp-config', SHARED_MCP_CONFIG,
  );

  const child = Bun.spawn({
    cmd,
    cwd: bot.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: CLAUDE_CONFIG_DIR_DEFAULT,
      // Inject this bot's own creds — channel server reads ZULIP_BOT_EMAIL /
      // ZULIP_API_KEY / ZULIP_HOME_STREAM and would otherwise inherit
      // dispatch-bot's creds from process.env.
      ZULIP_BOT_EMAIL: bot.bot_email,
      ZULIP_API_KEY: bot.bot_api_key,
      ZULIP_HOME_STREAM: bot.home_stream,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  log(`spawned @${bot.name}: pid=${child.pid} cwd=${bot.cwd}`);
  runningBots.set(bot.name, child);
  startTimes.set(bot.name, Date.now());

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
    startTimes.delete(bot.name);
    log(`@${bot.name} exited (code ${exitCode})`);

    // Capture the session_id of the just-ended session so the next wake can
    // --resume it. Picks the newest jsonl in the bot's CLAUDE_CONFIG_DIR
    // project directory.
    const sid = latestSessionId(CLAUDE_CONFIG_DIR_DEFAULT, bot.cwd);
    if (sid) {
      const state = readState(bot.name);
      state.session_id = sid;
      writeState(state);
      log(`@${bot.name}: stored session_id=${sid} for next resume`);
    }

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
    // TODO: post failure into #Dispatch and set state.broken to the message.
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

  // Route by stream: #Dispatch is for fleet-ops commands; bot home streams
  // are wake-up triggers; anything else we ignore.
  if (stream === DISPATCH_STREAM) {
    await handleDispatchCommand(msg);
    return;
  }

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

  const trigger: WakeTrigger = {
    stream,
    topic: msg.subject || 'chat',
    sender: msg.sender_full_name ?? '',
    content: msg.content ?? '',
  };
  await maybeSpawn(bot, trigger);
}

// ---------- Fleet-ops commands ----------

async function postToDispatch(topic: string, content: string): Promise<void> {
  try {
    await zulip('/messages', {
      method: 'POST',
      params: { type: 'stream', to: DISPATCH_STREAM, topic, content },
    });
  } catch (err: any) {
    log(`failed to post to #${DISPATCH_STREAM}: ${err.message}`);
  }
}

async function handleDispatchCommand(msg: any): Promise<void> {
  const text = String(msg.content ?? '').trim();
  const topic = msg.subject || 'general';
  log(`dispatch command from owner: ${JSON.stringify(text)}`);

  const cmd = parseCommand(text);
  switch (cmd.kind) {
    case 'spinUp':     return cmdSpinUp(topic, cmd.target);
    case 'shutDown':   return cmdShutDown(topic, cmd.target);
    case 'reset':      return cmdReset(topic, cmd.target);
    case 'listActive': return cmdListActive(topic);
    case 'status':     return cmdStatus(topic, cmd.target);
    case 'logs':       return cmdLogs(topic, cmd.target, cmd.n);
    case 'help':       return cmdHelp(topic);
    case 'unknown':
      await postToDispatch(topic, `unrecognized: \`${cmd.text}\`. try \`help\`.`);
  }
}

async function cmdSpinUp(topic: string, name: string): Promise<void> {
  const bot = REGISTRY[name];
  if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);
  if (isAlive(bot.name)) return postToDispatch(topic, `@${bot.name} is already running`);

  const trigger: WakeTrigger = {
    stream: bot.home_stream,
    topic: 'chat',
    sender: 'dispatch',
    content: `(spawned via @dispatch spin up — say hello in #${bot.home_stream} when you're ready)`,
  };
  await maybeSpawn(bot, trigger);
  await postToDispatch(topic, `spinning up @${bot.name}`);
}

async function cmdShutDown(topic: string, name: string): Promise<void> {
  const bot = REGISTRY[name];
  if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);
  const child = runningBots.get(bot.name);
  if (!child) return postToDispatch(topic, `@${bot.name} is not running`);
  try {
    child.kill('SIGTERM');
    await postToDispatch(topic, `sent SIGTERM to @${bot.name} (pid ${child.pid})`);
  } catch (err: any) {
    await postToDispatch(topic, `failed to kill @${bot.name}: ${err.message}`);
  }
}

// Kill (if running), wait for exit, then clear the stored session_id so the
// next spawn starts fresh instead of resuming. The `/clear` equivalent for
// the bot-as-a-fleet member.
async function cmdReset(topic: string, name: string): Promise<void> {
  const bot = REGISTRY[name];
  if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);

  const child = runningBots.get(bot.name);
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch (err: any) {
      log(`@${bot.name} reset: kill failed: ${err.message}`);
    }
    // Wait for the exit handler to run (it captures session_id, which we
    // immediately overwrite below). Bounded so a stuck child doesn't hang us.
    await Promise.race([
      child.exited,
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  }

  const state = readState(bot.name);
  state.session_id = null;
  writeState(state);

  await postToDispatch(
    topic,
    `@${bot.name} reset — session cleared; the next start will be a fresh conversation`,
  );
}

async function cmdListActive(topic: string): Promise<void> {
  if (runningBots.size === 0) return postToDispatch(topic, 'no bots currently running');
  const lines = ['**Running bots:**'];
  for (const [name, child] of runningBots) {
    const startedAt = startTimes.get(name);
    const uptime = startedAt ? humanDuration(Date.now() - startedAt) : '?';
    lines.push(`- @${name}: pid ${child.pid}, uptime ${uptime}`);
  }
  await postToDispatch(topic, lines.join('\n'));
}

async function cmdStatus(topic: string, name: string | undefined): Promise<void> {
  const targets = name ? [name] : Object.keys(REGISTRY);
  const lines: string[] = [];
  for (const n of targets) {
    const bot = REGISTRY[n];
    if (!bot) {
      lines.push(`- \`${n}\`: not in registry`);
      continue;
    }
    const state = readState(bot.name);
    const alive = isAlive(bot.name);
    const child = runningBots.get(bot.name);
    const startedAt = startTimes.get(bot.name);
    const uptime = startedAt && alive ? humanDuration(Date.now() - startedAt) : null;
    const lastActive = state.last_active ?? 'never';
    lines.push(
      `- @${bot.name}: ${alive ? `**alive** (pid ${child?.pid}, up ${uptime})` : 'sleeping'}; last_active ${lastActive}`,
    );
  }
  await postToDispatch(topic, lines.join('\n'));
}

async function cmdLogs(topic: string, name: string, n: number): Promise<void> {
  const bot = REGISTRY[name];
  if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);
  const path = join(LOG_DIR, `${bot.name}.log`);
  if (!existsSync(path)) return postToDispatch(topic, `no log file for @${bot.name} yet`);
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf-8').split('\n');
  } catch (err: any) {
    return postToDispatch(topic, `couldn't read log: ${err.message}`);
  }
  const tail = lines.slice(-n).join('\n');
  // Strip ANSI escape sequences so the Zulip post is readable.
  const stripped = tail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  await postToDispatch(topic, `**last ${n} lines of @${bot.name}:**\n\`\`\`\n${stripped.slice(-7000)}\n\`\`\``);
}

async function cmdHelp(topic: string): Promise<void> {
  await postToDispatch(
    topic,
    [
      '**Fleet-ops commands** (post in #' + DISPATCH_STREAM + '):',
      '- `spin up @<bot>` — start that bot (resumes prior session if known)',
      '- `shut down @<bot>` — kill that bot (next start will resume)',
      '- `reset @<bot>` — kill and clear stored session; next start is fresh',
      '- `list active` — running bots + uptime',
      '- `status [@<bot>]` — alive/sleeping + last activity (all bots if no name)',
      '- `logs @<bot> [n]` — last n lines of bot stdout/stderr (default 30)',
      '- `help` — this',
    ].join('\n'),
  );
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
