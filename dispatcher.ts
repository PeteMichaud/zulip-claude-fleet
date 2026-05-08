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
 * See README.md for the project overview.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeZulipClient } from './lib/zulip.ts';
import { parseCommand } from './lib/commands.ts';
import { humanDuration } from './lib/format.ts';
import { isIdle, makeBotStateStore, type BotState } from './lib/state.ts';
import { makeSpawnOrchestrator } from './lib/spawn-orchestrator.ts';
import { runStartupSequence } from './lib/startup.ts';

type Subprocess = ReturnType<typeof Bun.spawn>;
type WakeTrigger = { stream: string; topic: string; sender: string; content: string; inbound_message_id?: number };

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
  // Optional per-bot override. When unset, the bot inherits the dispatcher's
  // global default (CLAUDE_CONFIG_DIR env or ~/.claude). Lets a single fleet
  // mix bots running under different Claude config profiles.
  config_dir?: string;
};

// Bot working trees live under this directory. create-bot mkdirs
// <FLEET_ROOT>/<name>; retire moves it to <FLEET_ROOT>/_retired/<ts>_<name>.
const FLEET_ROOT = join(process.env.HOME ?? '', 'claude-fleet');
const RETIRED_ROOT = join(FLEET_ROOT, '_retired');

// Registry is persisted at state/registry.json. Loaded once at startup,
// rewritten on every mutation (create-bot, retire). On first run it's
// seeded from the legacy ZULIP_BOT_* env vars to migrate phase-1 setups.
const REGISTRY_PATH = join(import.meta.dir, 'state', 'registry.json');

function loadRegistry(): Record<string, Bot> {
  if (existsSync(REGISTRY_PATH)) {
    try {
      return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
    } catch (err: any) {
      throw new Error(`failed to parse ${REGISTRY_PATH}: ${err.message}`);
    }
  }
  // First run: seed from legacy env. Existing phase-1 setups have a single
  // briefing-shaped bot configured via ZULIP_BOT_* env vars.
  const legacyEmail = process.env.ZULIP_BOT_EMAIL;
  const legacyKey = process.env.ZULIP_API_KEY;
  const legacyStream = process.env.ZULIP_HOME_STREAM;
  if (legacyEmail && legacyKey && legacyStream) {
    const seeded: Record<string, Bot> = {
      [legacyStream]: {
        name: legacyStream,
        home_stream: legacyStream,
        cwd: join(FLEET_ROOT, legacyStream),
        bot_email: legacyEmail,
        bot_api_key: legacyKey,
      },
    };
    saveRegistry(seeded);
    return seeded;
  }
  return {};
}

function saveRegistry(reg: Record<string, Bot>): void {
  const tmp = `${REGISTRY_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  renameSync(tmp, REGISTRY_PATH);
}

const REGISTRY: Record<string, Bot> = loadRegistry();

const STATE_DIR = join(import.meta.dir, 'state');
const LOG_DIR = join(STATE_DIR, 'logs');
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const SHARED_MCP_CONFIG = join(import.meta.dir, 'shared-mcp.json');
const PTY_HELPER = join(import.meta.dir, 'scripts', 'pty-helper.py');

// Resolve which Claude config dir a bot runs under. Precedence:
//   1. Per-bot override (Bot.config_dir, settable via `create --config` /
//      `update --config`).
//   2. Dispatcher-wide override from the CLAUDE_CONFIG_DIR env var.
//   3. Repo default: ~/.claude (the standard Claude Code location).
// Operators with a non-default profile (e.g. ~/.claude-sfc, ~/.claude-mimo)
// just launch the dispatcher with CLAUDE_CONFIG_DIR set in their shell or
// .env and the whole fleet inherits it.
const GLOBAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude');

function configDirFor(bot: Bot): string {
  return bot.config_dir ?? GLOBAL_CONFIG_DIR;
}

// ---------- Logging ----------

function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`;
  console.log(line);
}

// ---------- Zulip API clients ----------

// `zulip` is dispatch-bot's identity — used for nearly everything. Its event
// queue, posts in #Dispatch, stream/user lookups, deactivations, archivals.
const zulip = makeZulipClient({
  site: SITE,
  email: DISPATCH_BOT_EMAIL,
  apiKey: DISPATCH_BOT_API_KEY,
});

// `zulipAsOwner` is the owner's (real-user) identity. Needed only for
// endpoints that explicitly reject bot callers — namely `/bots` for creating
// new bot users. Optional at startup; if OWNER_API_KEY isn't in .env,
// create-bot fails at command time with a clear message rather than blocking
// startup.
const OWNER_EMAIL = process.env.OWNER_EMAIL;
const OWNER_API_KEY = process.env.OWNER_API_KEY;
const zulipAsOwner = OWNER_EMAIL && OWNER_API_KEY
  ? makeZulipClient({ site: SITE, email: OWNER_EMAIL, apiKey: OWNER_API_KEY })
  : null;

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

const stateStore = makeBotStateStore({ baseDir: STATE_DIR, log });
const readState = stateStore.read;
const writeState = stateStore.write;

// ---------- Startup auth check ----------

log('dispatcher starting');

let me: { email: string; user_id: number; [k: string]: unknown };
try {
  ({ me } = await runStartupSequence({ zulip, registry: REGISTRY, log }));
} catch (err: any) {
  log('FATAL:', err.message);
  process.exit(1);
}

// dispatch-bot's user_id, passed to spawned channel servers so they accept
// our forward posts (@-mention relay, see processMentions below).
const DISPATCH_BOT_USER_ID: number = me.user_id;

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

  const botConfigDir = configDirFor(bot);
  // Pretrust the working tree under whichever config dir we're about to
  // spawn into. Idempotent — safe to call every spawn — and ensures the
  // workspace-trust dialog never appears even if config_dir changed since
  // create-time.
  try {
    pretrustDirectory(bot.cwd, botConfigDir);
  } catch (err: any) {
    log(`@${bot.name}: pre-trust failed (non-fatal): ${err.message}`);
  }

  const child = Bun.spawn({
    cmd,
    cwd: bot.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: botConfigDir,
      // Inject this bot's own creds — channel server reads ZULIP_BOT_EMAIL /
      // ZULIP_API_KEY / ZULIP_HOME_STREAM and would otherwise inherit
      // dispatch-bot's creds from process.env.
      ZULIP_BOT_EMAIL: bot.bot_email,
      ZULIP_API_KEY: bot.bot_api_key,
      ZULIP_HOME_STREAM: bot.home_stream,
      // Telling the channel server who the dispatcher is so it'll accept
      // our forward posts (otherwise its sender gate drops them).
      DISPATCH_BOT_USER_ID: String(DISPATCH_BOT_USER_ID),
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
    const sid = latestSessionId(botConfigDir, bot.cwd);
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

const { maybeSpawn } = makeSpawnOrchestrator<Bot, WakeTrigger>({
  isAlive,
  bumpActivity,
  spawnBot,
  log,
});

// ---------- Inbound handler ----------

function botForStream(stream: string): Bot | undefined {
  return Object.values(REGISTRY).find((b) => b.home_stream === stream);
}

async function handleMessage(event: any) {
  const msg = event.message;
  const senderEmail = String(msg.sender_email ?? '');
  const stream = typeof msg.display_recipient === 'string' ? msg.display_recipient : '';

  // Always ignore our own posts (dispatch-bot's queue receives messages
  // it itself sends, since it's subscribed to the streams it posts in).
  if (senderEmail === DISPATCH_BOT_EMAIL) return;

  // #Dispatch: fleet-ops commands. Owner can do anything; bots can issue
  // self-targeted commands. Sender filtering happens inside.
  if (stream === DISPATCH_STREAM) {
    await handleDispatchCommand(msg);
    return;
  }

  const homeBot = botForStream(stream);
  if (!homeBot) {
    log(`inbound in unregistered stream "${stream}", ignoring`);
    return;
  }

  const isOwner = msg.sender_id === OWNER_USER_ID;
  const issuingBot = isOwner ? undefined : botFromSender(senderEmail);
  if (!isOwner && !issuingBot) return; // unknown sender — ignore

  // Bump activity timestamps. Owner messages count as activity for the
  // home bot (the addressee). Bot-self posts count as activity for that
  // bot (it's working — don't auto-idle-shut while it's mid-reply).
  if (isOwner) {
    bumpActivity(homeBot.name);
  } else if (issuingBot) {
    bumpActivity(issuingBot.name);
  }

  // Wake-up logic: only the operator's messages summon a sleeping bot. A
  // registered bot posting in its own stream is already alive (or will be
  // mediated by @-mention forwarding below if it's mentioning someone else).
  if (isOwner) {
    const snippet = (msg.content ?? '').slice(0, 100).replace(/\n/g, ' ');
    log(`inbound for @${homeBot.name}: topic="${msg.subject ?? ''}" sender="${msg.sender_full_name ?? ''}" content=${JSON.stringify(snippet)}`);

    if (!isAlive(homeBot.name)) {
      const trigger: WakeTrigger = {
        stream,
        topic: msg.subject || 'chat',
        sender: msg.sender_full_name ?? '',
        content: msg.content ?? '',
        inbound_message_id: msg.id,
      };
      await maybeSpawn(homeBot, trigger);
    }
    // (If alive, the bot's own MCP queue picks up the message; dispatcher
    // does nothing further for the wake-up path.)
  }

  // @-mention relay: scan for mentions of OTHER registered bots and forward
  // each one to its target. Owner-issued mentions and bot-issued mentions
  // both flow through here.
  await processMentions(msg, stream, homeBot);
}

// Find a bot in the registry whose Zulip identity sent this message.
// Used to allow bots to issue self-targeted commands in #Dispatch and to
// propagate @-mentions originating from one bot to another.
function botFromSender(senderEmail: string): Bot | undefined {
  return Object.values(REGISTRY).find((b) => b.bot_email === senderEmail);
}

// ---------- @-mention relay ----------

// Recent forward timestamps per target bot. When a target has been forwarded
// to >FORWARD_RATE_LIMIT times in the last FORWARD_RATE_WINDOW_MS, drop the
// next forward. Crude loop guard — a bot-X-mentions-bot-Y-mentions-bot-X
// cycle terminates within seconds at depth ~10.
const forwardCounts = new Map<string, number[]>();
const FORWARD_RATE_LIMIT = 10;
const FORWARD_RATE_WINDOW_MS = 60_000;

function shouldForwardTo(botName: string): boolean {
  const now = Date.now();
  const recent = (forwardCounts.get(botName) ?? []).filter(
    (t) => now - t < FORWARD_RATE_WINDOW_MS,
  );
  if (recent.length >= FORWARD_RATE_LIMIT) return false;
  recent.push(now);
  forwardCounts.set(botName, recent);
  return true;
}

// Match Zulip-formal @**Display Name** (we set Display Name = <name>-bot)
// and informal @<name> or @<name>-bot. Returns deduped bots in mention order.
function findMentionedBots(content: string): Bot[] {
  const seen = new Set<string>();
  const out: Bot[] = [];
  const collect = (raw: string) => {
    const candidate = raw.toLowerCase().replace(/-bot$/, '').trim();
    const bot = REGISTRY[candidate];
    if (bot && !seen.has(bot.name)) {
      seen.add(bot.name);
      out.push(bot);
    }
  };
  for (const m of content.matchAll(/@\*\*([^*]+)\*\*/g)) collect(m[1]);
  for (const m of content.matchAll(/@([a-z][\w-]*)/gi)) collect(m[1]);
  return out;
}

// Returns the number of forwards actually issued (post-rate-limit, post-self-filter).
async function processMentions(
  msg: any,
  originStream: string,
  homeBot: Bot | undefined,
): Promise<number> {
  const content = String(msg.content ?? '');
  const targets = findMentionedBots(content).filter(
    (t) => !homeBot || t.name !== homeBot.name,
  );
  let count = 0;
  for (const target of targets) {
    if (!shouldForwardTo(target.name)) {
      log(`forward suppressed (rate limit hit): @${target.name}`);
      continue;
    }
    await forwardMention(target, msg, originStream).catch((err: any) =>
      log(`forward to @${target.name} failed: ${err.message}`),
    );
    count++;
  }
  return count;
}

async function forwardMention(target: Bot, originalMsg: any, originStream: string): Promise<void> {
  const sender = String(originalMsg.sender_full_name ?? '');
  const originTopic = String(originalMsg.subject ?? 'chat');
  const text = String(originalMsg.content ?? '');

  const forwarded = [
    `*(forwarded from #${originStream}, topic "${originTopic}", mentioned by ${sender})*`,
    '',
    text,
    '',
    `If you reply, post to #${originStream} via \`send(stream="${originStream}", topic="${originTopic}", text=...)\`.`,
  ].join('\n');

  bumpActivity(target.name); // a freshly-summoned bot shouldn't be auto-idled
  if (isAlive(target.name)) {
    log(`forwarding mention to @${target.name} (alive) via #${target.home_stream}`);
    await zulip('/messages', {
      method: 'POST',
      params: {
        type: 'stream',
        to: target.home_stream,
        topic: 'mentions',
        content: forwarded,
      },
    });
  } else {
    log(`forwarding mention to @${target.name} (sleeping) — will spawn`);
    const trigger: WakeTrigger = {
      stream: target.home_stream,
      topic: 'mentions',
      sender: 'dispatch (forwarded mention)',
      content: forwarded,
    };
    await maybeSpawn(target, trigger);
  }
}

// ---------- Activity tracking + idle shutdown ----------

function bumpActivity(botName: string): void {
  stateStore.bumpActivity(botName);
}

const IDLE_TIMEOUT_MS = parseInt(
  process.env.BOT_IDLE_TIMEOUT_MS ?? String(30 * 60 * 1000),
  10,
);
const IDLE_CHECK_INTERVAL_MS = 60_000; // walk runningBots once a minute

async function checkIdleBots(): Promise<void> {
  const now = Date.now();
  for (const [name] of runningBots) {
    const state = readState(name);
    if (!isIdle({ lastActive: state.last_active, thresholdMs: IDLE_TIMEOUT_MS, now })) continue;
    const idleMs = now - Date.parse(state.last_active!);
    await idleShutdown(name, idleMs).catch((err: any) =>
      log(`idle shutdown of @${name} failed: ${err.message}`),
    );
  }
}

async function idleShutdown(name: string, idleMs: number): Promise<void> {
  const bot = REGISTRY[name];
  const child = runningBots.get(name);
  if (!bot || !child) return;

  log(`@${name}: idle for ${humanDuration(idleMs)} — auto-sleeping`);

  // Post a notice into the bot's home stream first, so the operator sees
  // why their session went away. Topic "lifecycle" so the system messages
  // don't pollute whatever conversation topic is active.
  await zulip('/messages', {
    method: 'POST',
    params: {
      type: 'stream',
      to: bot.home_stream,
      topic: 'lifecycle',
      content: `💤 Auto-sleeping @${name} after ${humanDuration(idleMs)} idle. Send any message in this stream to wake again.`,
    },
  }).catch((err: any) => log(`@${name}: idle notice post failed: ${err.message}`));

  try {
    child.kill('SIGTERM');
  } catch (err: any) {
    log(`@${name}: idle SIGTERM failed: ${err.message}`);
  }
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
  const senderEmail = String(msg.sender_email ?? '');

  // (handleMessage already filters dispatch-bot's own posts before we get here.)

  // Identify the sender. Owner gets full command access; a registered bot
  // gets a self-restricted subset (so it can request its own reset/shutdown
  // after self-modification). Anyone else is ignored silently.
  const isOwner = msg.sender_id === OWNER_USER_ID;
  const issuingBot = isOwner ? undefined : botFromSender(senderEmail);
  if (!isOwner && !issuingBot) {
    log(`#${DISPATCH_STREAM} message from unknown sender ${senderEmail} — ignored`);
    return;
  }

  log(`dispatch command from ${isOwner ? 'owner' : `@${issuingBot!.name}`}: ${JSON.stringify(text)}`);

  const cmd = parseCommand(text);

  // Bot senders are restricted to self-targeted reset / shutDown only.
  if (issuingBot) {
    const target = (cmd as { target?: string }).target;
    const allowed =
      (cmd.kind === 'reset' || cmd.kind === 'shutDown') &&
      target === issuingBot.name;
    if (!allowed) {
      log(`@${issuingBot.name} unauthorized: ${cmd.kind} ${target ?? ''} — ignored`);
      return;
    }
  }
  switch (cmd.kind) {
    case 'spinUp':     return cmdSpinUp(topic, cmd.target);
    case 'shutDown':   return cmdShutDown(topic, cmd.target);
    case 'reset':      return cmdReset(topic, cmd.target);
    case 'create':     return cmdCreate(topic, cmd.target, cmd.configDir);
    case 'update':     return cmdUpdate(topic, cmd.target, cmd);
    case 'retire':     return cmdRetire(topic, cmd.target);
    case 'listActive': return cmdListActive(topic);
    case 'status':     return cmdStatus(topic, cmd.target);
    case 'logs':       return cmdLogs(topic, cmd.target, cmd.n);
    case 'help':       return cmdHelp(topic);
    case 'unknown': {
      // Not a command — maybe it's chat that mentions a bot. #Dispatch
      // doubles as a general "talk to any bot" surface so the operator
      // doesn't have to switch streams.
      const forwarded = await processMentions(msg, DISPATCH_STREAM, undefined);
      if (forwarded === 0) {
        await postToDispatch(topic, `unrecognized: \`${cmd.text}\`. try \`help\`.`);
      }
    }
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

// Provision a new bot end-to-end. Bot creation goes through the owner's
// credentials because Zulip's /bots endpoint rejects bot callers; everything
// else uses dispatch-bot.
async function cmdCreate(topic: string, name: string, configDir?: string): Promise<void> {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    return postToDispatch(topic, `invalid name \`${name}\` — must start with a lowercase letter and contain only [a-z0-9_-]`);
  }
  if (REGISTRY[name]) {
    return postToDispatch(topic, `\`${name}\` already in registry; pick a different name or \`retire\` it first`);
  }
  if (!zulipAsOwner) {
    return postToDispatch(
      topic,
      `OWNER_API_KEY not configured. Add OWNER_EMAIL and OWNER_API_KEY to .env (your personal user creds) so the dispatcher can create bot users on your behalf.`,
    );
  }

  await postToDispatch(topic, `creating @${name}…`);

  // Step 1: create the bot user via the owner's account. /bots rejects
  // bot callers, so we use the owner's user creds for this one call only.
  let botUser: { user_id: number; email: string; api_key: string };
  try {
    const created = await zulipAsOwner('/bots', {
      method: 'POST',
      params: {
        full_name: `${name}-bot`,
        // Zulip auto-appends `-bot@<realm>` to short_name. Passing `<name>-bot`
        // here produced `<name>-bot-bot@…`; pass the bare name and let Zulip
        // synthesize the suffix.
        short_name: name,
        bot_type: 1, // generic
      },
    });
    if (typeof created.user_id !== 'number' || !created.api_key) {
      throw new Error(`unexpected /bots response: ${JSON.stringify(created)}`);
    }
    // /bots response in some Zulip versions omits `email`; look it up
    // explicitly via /users/{id} to get the authoritative record.
    const userInfo = await zulip(`/users/${created.user_id}`);
    const email = userInfo.user?.email;
    if (typeof email !== 'string' || email.length === 0) {
      throw new Error(`bot created (user_id ${created.user_id}) but /users lookup returned no email`);
    }
    botUser = { user_id: created.user_id, email, api_key: created.api_key };
    log(`@${name}: created bot user (user_id ${botUser.user_id}, email ${botUser.email})`);
  } catch (err: any) {
    return postToDispatch(topic, `failed to create bot user: ${err.message}`);
  }

  // Step 2: create the home stream and subscribe owner + new bot. Zulip
  // auto-subscribes the caller (dispatch-bot here, since `zulip` is its client).
  try {
    await zulip('/users/me/subscriptions', {
      method: 'POST',
      params: {
        subscriptions: [{ name }],
        principals: [OWNER_USER_ID, botUser.user_id],
      },
    });
    log(`@${name}: stream #${name} ready, subscribers include owner + new bot + dispatch-bot`);
  } catch (err: any) {
    return postToDispatch(
      topic,
      `bot user created but stream creation failed: ${err.message}. orphan bot user_id=${botUser.user_id}, email=${botUser.email} — deactivate manually or call \`retire\` after manually adding it to the registry`,
    );
  }

  // Step 3: scaffold the working tree.
  const cwd = join(FLEET_ROOT, name);
  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, 'CLAUDE.md'), claudeMdStub(name));
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['mcp__zulip-channel__*'] } }, null, 2) + '\n',
    );
    log(`@${name}: scaffolded working tree at ${cwd}`);
  } catch (err: any) {
    return postToDispatch(topic, `stream OK but working tree scaffold failed: ${err.message}`);
  }

  // Pretrust happens at spawn time now (see spawnBot), so we don't repeat
  // it here — the working tree won't be entered by Claude until first wake.

  // Step 4: register and persist.
  const entry: Bot = {
    name,
    home_stream: name,
    cwd,
    bot_email: botUser.email,
    bot_api_key: botUser.api_key,
  };
  if (configDir) entry.config_dir = configDir;
  REGISTRY[name] = entry;
  saveRegistry(REGISTRY);

  const lines = [
    `✓ @${name} created`,
    `- bot user: \`${botUser.email}\` (user_id ${botUser.user_id})`,
    `- home stream: \`#${name}\``,
    `- working tree: \`${cwd}\``,
  ];
  if (configDir) lines.push(`- config dir: \`${configDir}\` (per-bot override)`);
  lines.push(`Run \`spin up ${name}\` and tell it what kind of bot to be.`);
  await postToDispatch(topic, lines.join('\n'));
}

// Mutate a bot's registry entry. Today only --config / --clear-config are
// wired; the command shape supports adding more per-bot fields later. Changes
// take effect on next spawn — running bots keep their old config until reset.
async function cmdUpdate(
  topic: string,
  name: string,
  opts: { configDir?: string; clearConfig?: boolean },
): Promise<void> {
  const bot = REGISTRY[name];
  if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);

  // No flags → show current config-dir for this bot.
  if (!opts.configDir && !opts.clearConfig) {
    const effective = configDirFor(bot);
    const overridden = bot.config_dir ? ' (per-bot override)' : ' (global default)';
    return postToDispatch(
      topic,
      `@${name} config dir: \`${effective}\`${overridden}`,
    );
  }

  if (opts.configDir && opts.clearConfig) {
    return postToDispatch(topic, `\`--config\` and \`--clear-config\` are mutually exclusive`);
  }

  if (opts.clearConfig) {
    delete bot.config_dir;
  } else if (opts.configDir) {
    bot.config_dir = opts.configDir;
  }
  saveRegistry(REGISTRY);

  // Session jsonls live under the OLD config dir, so a `--resume <sid>` from
  // the new dir would fail. Clear stored session_id so next spawn starts
  // fresh. The bot's CLAUDE.md and HANDOFF.md (in cwd) still survive, so
  // identity isn't lost — only the conversation history.
  const state = readState(name);
  state.session_id = null;
  writeState(state);

  const effective = configDirFor(bot);
  const note = isAlive(name)
    ? ` running session keeps the old config until you \`reset ${name}\` or it dies.`
    : '';
  await postToDispatch(
    topic,
    `@${name} config dir → \`${effective}\`. Session cleared (next start is fresh).${note}`,
  );
}

// Mark `cwd` as trusted in <configDir>/.claude.json so the workspace-trust
// dialog doesn't appear on first spawn. Read-modify-atomic-rename to minimize
// races with other Claude processes that update the same file.
function pretrustDirectory(cwd: string, configDir: string): void {
  const path = join(configDir, '.claude.json');
  let data: any = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err: any) {
      throw new Error(`couldn't parse ${path}: ${err.message}`);
    }
  }
  if (!data.projects || typeof data.projects !== 'object') data.projects = {};
  if (!data.projects[cwd] || typeof data.projects[cwd] !== 'object') {
    data.projects[cwd] = {};
  }
  data.projects[cwd].hasTrustDialogAccepted = true;
  data.projects[cwd].hasCompletedProjectOnboarding = true;

  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

function claudeMdStub(name: string): string {
  return `# ${name}-bot

You are a Claude session reachable via the Zulip stream \`#${name}\`. Your operator is whoever runs this fleet's dispatcher.

This file is the **stub** that the dispatcher wrote when it provisioned you. Your operator is going to tell you what kind of bot you should be — your role, scope, conventions, what tools to use freely, what to ask permission for. When they do, edit this file (the \`## Your scope\` section especially) so the new persona persists across sessions. After you've made the edit, ask the dispatcher to reset you so the next session starts with the new identity:

\`\`\`
send(stream="Dispatch", text="reset ${name}")
\`\`\`

The dispatcher will kill this session, clear your stored conversation, and the next time your operator writes to you, you'll wake up fresh with the new CLAUDE.md as your identity.

## How you're wired up

- Messages from your operator arrive as \`<channel source="zulip-channel" stream="${name}" topic="..." sender="...">\` events.
- You reply by calling the \`send\` tool. Default destination is the same stream and topic as the inbound message.
- You can read history from any stream you have access to via the \`read\` tool.
- Tool calls that need permission (Bash, Write, Edit) are relayed to Zulip; your operator taps a ✅ reaction or replies \`yes <id>\`.
- You can post in \`#Dispatch\` to issue self-targeted lifecycle commands: \`reset ${name}\` (above) or \`shut down ${name}\` (just sleep, will resume when your operator writes to you next).

## Your scope

*(Operator to fill in — this is a placeholder.)*

- This bot is for:
- Conventions / preferences:
- Tools to use freely:
- Tools to ask before using:

## Communication style

- Replies appear as Zulip messages. Keep them short and direct unless asked otherwise.
- Markdown renders in Zulip — code fences, headings, lists all work.
- For long outputs the \`send\` tool chunks automatically; don't try to hand-chunk.
- Check for \`HANDOFF.md\` in this directory at session start; it contains your prior self's notes if there's been a previous session.
`;
}

// Retire a bot: kill if running, deactivate the Zulip bot user, archive the
// stream, remove from registry. Working tree is moved into _retired/ so the
// main fleet dir stays uncluttered (manual unretire = mv it back).
async function cmdRetire(topic: string, name: string): Promise<void> {
  const bot = REGISTRY[name];
  if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);

  await postToDispatch(topic, `retiring @${name}…`);

  // Step 1: kill if running.
  const child = runningBots.get(bot.name);
  if (child) {
    try {
      child.kill('SIGTERM');
      await Promise.race([
        child.exited,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch (err: any) {
      log(`@${bot.name} retire: kill failed: ${err.message}`);
    }
  }

  // Step 2: look up the bot's user_id from Zulip. If bot_email is missing
  // (e.g. broken registry entry from an earlier failed create-bot), we look
  // up by stream subscribers as a fallback, or skip user deactivation.
  let userId: number | null = null;
  if (bot.bot_email) {
    try {
      const res = await zulip(`/users/${encodeURIComponent(bot.bot_email)}`);
      userId = res.user?.user_id ?? null;
    } catch (err: any) {
      log(`@${bot.name} retire: couldn't look up user_id: ${err.message}`);
    }
  } else {
    log(`@${bot.name} retire: bot_email missing from registry — skipping user lookup`);
  }

  // Step 3: deactivate the bot user. Reversible; preserves history.
  // Zulip's DELETE /users/<id> only handles human users — bots use the
  // /bots/<id> endpoint instead. dispatch-bot's admin role is sufficient.
  if (userId !== null) {
    try {
      await zulip(`/bots/${userId}`, { method: 'DELETE' });
      log(`@${bot.name} retire: deactivated bot user_id ${userId}`);
    } catch (err: any) {
      log(`@${bot.name} retire: deactivation failed: ${err.message}`);
    }
  }

  // Step 4: archive the stream. Reversible by an admin; messages preserved.
  try {
    const streams = await zulip('/streams');
    const stream = (streams.streams as any[]).find((s) => s.name === bot.home_stream);
    if (stream) {
      await zulip(`/streams/${stream.stream_id}`, { method: 'DELETE' });
      log(`@${bot.name} retire: archived stream #${bot.home_stream} (id ${stream.stream_id})`);
    }
  } catch (err: any) {
    log(`@${bot.name} retire: stream archive failed: ${err.message}`);
  }

  // Step 5: remove from registry, persist.
  delete REGISTRY[name];
  saveRegistry(REGISTRY);

  // Step 6: move the working tree under _retired/ so the main fleet dir
  // stays clean. Timestamped so re-creating + re-retiring the same name
  // doesn't clobber prior archives. Manual un-retire = mv back.
  let archivedPath: string | null = null;
  if (existsSync(bot.cwd)) {
    try {
      mkdirSync(RETIRED_ROOT, { recursive: true });
      // ISO timestamp with colons replaced for FS-safety: 2026-05-07T20-58-30Z
      const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+/, '');
      archivedPath = join(RETIRED_ROOT, `${ts}_${name}`);
      renameSync(bot.cwd, archivedPath);
      log(`@${bot.name} retire: moved working tree to ${archivedPath}`);
    } catch (err: any) {
      log(`@${bot.name} retire: failed to archive working tree: ${err.message}`);
      archivedPath = null;
    }
  }

  const archiveLine = archivedPath
    ? `Working tree archived to \`${archivedPath}\` — \`mv\` it back to unretire.`
    : `Working tree at \`${bot.cwd}\` left in place (archive failed; rm or move manually).`;
  await postToDispatch(
    topic,
    `✓ @${name} retired (bot deactivated, stream archived, registry cleared). ${archiveLine}`,
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
  // Each row pairs the canonical form with its aliases (parseCommand accepts
  // any of them). Kept in sync with lib/commands.ts ALIASES manually.
  const rows: Array<[string, string, string?]> = [
    ['spin up @<bot>', 'start that bot (resumes prior session if known)', 'wake, wake up, start'],
    ['shut down @<bot>', 'kill that bot (next start will resume)', 'stop, kill'],
    ['reset @<bot>', 'kill and clear stored session; next start is fresh'],
    ['create <name> [--config <path>]', 'provision a new bot end-to-end', 'create-bot'],
    ['update <name> [--config <path> | --clear-config]', 'change a bot\'s per-bot settings (clears session so changes take effect)'],
    ['retire <name>', 'kill, deactivate Zulip bot, archive stream, remove from registry'],
    ['list active', 'running bots + uptime', 'list'],
    ['status [@<bot>]', 'alive/sleeping + last activity (all bots if no name)'],
    ['logs @<bot> [n]', 'last n lines of bot stdout/stderr (default 30)', 'log'],
    ['help', 'this'],
  ];
  const body = rows.map(([cmd, desc, aliases]) => {
    const tail = aliases ? ` _(aliases: ${aliases})_` : '';
    return `- \`${cmd}\` — ${desc}${tail}`;
  });
  await postToDispatch(
    topic,
    ['**Fleet-ops commands** (post in #' + DISPATCH_STREAM + '):', ...body].join('\n'),
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
  clearInterval(idleTimer);
  for (const [name, child] of runningBots) {
    log(`terminating @${name} (pid ${child.pid})`);
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Periodic sweep for idle bots. Default threshold 30 minutes (overridable
// via BOT_IDLE_TIMEOUT_MS env var). Cleared in shutdown handler.
const idleTimer = setInterval(() => {
  if (!running) return;
  checkIdleBots().catch((err: any) => log(`idle sweep failed: ${err.message}`));
}, IDLE_CHECK_INTERVAL_MS);
log(`idle shutdown enabled: ${humanDuration(IDLE_TIMEOUT_MS)} threshold, sweep every ${humanDuration(IDLE_CHECK_INTERVAL_MS)}`);

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
