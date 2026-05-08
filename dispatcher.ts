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
import { isDestructive, parseCommand, renderCommand, type Command } from './lib/commands.ts';
import { makeDispatchHandlers } from './lib/dispatch-handlers.ts';
import { humanDuration } from './lib/format.ts';
import { nlDispatch } from './lib/nl-dispatch.ts';
import { isIdle, makeBotStateStore } from './lib/state.ts';
import { makeSpawnOrchestrator } from './lib/spawn-orchestrator.ts';
import { runStartupSequence } from './lib/startup.ts';
import type { Bot, Subprocess, WakeTrigger } from './lib/types.ts';
import { fetchMessagesSince } from './lib/zulip-catchup.ts';

// ---------- Config ----------

const SITE = mustEnv('ZULIP_SITE');
const OWNER_USER_ID = parseInt(mustEnv('ZULIP_OWNER_USER_ID'), 10);

// The dispatcher operates under @dispatch-bot's identity. Its event queue
// gets messages from every stream dispatch-bot is subscribed to (its own
// home stream + every bot's home stream).
const DISPATCH_BOT_EMAIL = mustEnv('DISPATCH_BOT_EMAIL');
const DISPATCH_BOT_API_KEY = mustEnv('DISPATCH_BOT_API_KEY');
const DISPATCH_STREAM = mustEnv('DISPATCH_STREAM');

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
// Bookmark of the highest msg.id we've successfully handed off to handleMessage.
// Distinct from lastEventId (queue events are a different namespace and gone
// when the queue dies). Used by the catch-up fetch on re-register to recover
// messages buffered on the dying queue.
let lastHandledMessageId = 0;

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
  if (bot.yolo) {
    // Bypass Claude Code's permission system entirely. The channel server's
    // permission_request handler never fires under this flag, so neither
    // `auto` nor the danger filter run — yolo really is yolo.
    cmd.push('--dangerously-skip-permissions');
    log(`@${bot.name}: spawning with --dangerously-skip-permissions (yolo mode)`);
  }

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
      // auto mode: channel server short-circuits non-danger permission
      // prompts to allow without bothering the operator. The danger filter
      // still applies. yolo (above) is a stronger bypass at the claude-cli
      // level and obviates the channel server's permission path entirely.
      ...(bot.auto ? { ZULIP_AUTO_APPROVE: '1' } : {}),
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

// Fleet-ops command handlers — extracted to lib/dispatch-handlers.ts. The
// returned `executeCommand` and `postToDispatch` are the only entry points
// the dispatcher needs to route parsed/NL commands and post acknowledgements.
const handlers = makeDispatchHandlers({
  zulip,
  zulipAsOwner,
  log,
  registry: REGISTRY,
  saveRegistry,
  runningBots,
  startTimes,
  isAlive,
  maybeSpawn,
  stateStore,
  configDirFor,
  ownerUserId: OWNER_USER_ID,
  dispatchStream: DISPATCH_STREAM,
  fleetRoot: FLEET_ROOT,
  retiredRoot: RETIRED_ROOT,
  logDir: LOG_DIR,
});
const { executeCommand, postToDispatch } = handlers;

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
    // Bot's own first post in its home stream after a spawn → spawn done,
    // clear the ♻️ marker so 👀/✅ stand alone.
    if (issuingBot.name === homeBot.name) {
      const inboundMsgId = pendingRecycle.get(homeBot.name);
      if (inboundMsgId !== undefined) {
        pendingRecycle.delete(homeBot.name);
        clearRecycle(inboundMsgId);
      }
    }
  }

  // Wake-up logic: only the operator's messages summon a sleeping bot. A
  // registered bot posting in its own stream is already alive (or will be
  // mediated by @-mention forwarding below if it's mentioning someone else).
  if (isOwner) {
    const snippet = (msg.content ?? '').slice(0, 100).replace(/\n/g, ' ');
    log(`inbound for @${homeBot.name}: topic="${msg.subject ?? ''}" sender="${msg.sender_full_name ?? ''}" content=${JSON.stringify(snippet)}`);

    if (!isAlive(homeBot.name)) {
      // Spawn-window indicator. Track the inbound msg.id so we can clear
      // the ♻️ when the bot's first self-post lands.
      if (typeof msg.id === 'number') {
        pendingRecycle.set(homeBot.name, msg.id);
        reactRecycle(msg.id);
      }
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

// ---------- Spawn-window UI ----------
// When the dispatcher kicks off a fresh spawn (sleeping bot, owner message),
// react ♻️ on the inbound so the operator sees "booting." Channel server then
// layers 👀 on top once Claude has the message in hand. We clear the ♻️ when
// the bot's first self-post lands in home stream — earliest signal that the
// spawn has completed and Claude is replying.
const pendingRecycle = new Map<string, number>(); // botName → inbound msg.id

function reactRecycle(msgId: number): void {
  zulip(`/messages/${msgId}/reactions`, {
    method: 'POST',
    params: { emoji_name: 'recycle' },
  }).catch((err: any) => log(`recycle: react failed (non-fatal): ${err.message}`));
}

function clearRecycle(msgId: number): void {
  zulip(`/messages/${msgId}/reactions`, {
    method: 'DELETE',
    params: { emoji_name: 'recycle' },
  }).catch((err: any) => log(`recycle: clear failed (non-fatal): ${err.message}`));
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

// ---------- #Dispatch routing ----------

// Owner gets full command access; a registered bot is restricted to
// self-targeted reset/shutdown (so it can request its own restart after
// self-modification); anyone else is ignored silently.
type DispatchSender =
  | { kind: 'owner' }
  | { kind: 'bot'; bot: Bot }
  | { kind: 'unknown' };

function classifyDispatchSender(msg: any): DispatchSender {
  if (msg.sender_id === OWNER_USER_ID) return { kind: 'owner' };
  const bot = botFromSender(String(msg.sender_email ?? ''));
  if (bot) return { kind: 'bot', bot };
  return { kind: 'unknown' };
}

function botCanIssue(bot: Bot, cmd: Command): boolean {
  const target = (cmd as { target?: string }).target;
  return (cmd.kind === 'reset' || cmd.kind === 'shutDown') && target === bot.name;
}

async function handleDispatchCommand(msg: any): Promise<void> {
  // (handleMessage already filters dispatch-bot's own posts before we get here.)
  const sender = classifyDispatchSender(msg);
  if (sender.kind === 'unknown') {
    log(`#${DISPATCH_STREAM} message from unknown sender ${msg.sender_email} — ignored`);
    return;
  }

  const text = String(msg.content ?? '').trim();
  const topic = msg.subject || 'general';
  log(`dispatch command from ${sender.kind === 'owner' ? 'owner' : `@${sender.bot.name}`}: ${JSON.stringify(text)}`);

  const cmd = parseCommand(text);

  if (sender.kind === 'bot' && !botCanIssue(sender.bot, cmd)) {
    log(`@${sender.bot.name} unauthorized: ${cmd.kind} ${(cmd as { target?: string }).target ?? ''} — ignored`);
    return;
  }
  if (cmd.kind !== 'unknown') return executeCommand(cmd, topic);

  // Not a regex-parseable command. Try mention forwarding first (the
  // operator may be chatting *to* a bot from #Dispatch). If nothing was
  // forwarded and the sender is the owner, fall through to the NL parser.
  const forwarded = await processMentions(msg, DISPATCH_STREAM, undefined);
  if (forwarded > 0) return;

  const plan = await nlDispatch(text);
  if (plan === null) {
    await postToDispatch(topic, `unrecognized: \`${cmd.text}\`. try \`help\`.`);
    return;
  }
  if (plan.length === 0) {
    await postToDispatch(topic, `not sure what command \`${cmd.text}\` maps to. try \`help\`.`);
    return;
  }

  // Destructive ops (retire/reset) require the operator to retype the explicit
  // form — guessing at "kill the writer" with reset/retire is too easy to get
  // wrong. If even one step in the plan is destructive, refuse the whole batch.
  const dangerous = plan.filter((c) => isDestructive(c));
  if (dangerous.length > 0) {
    const rendered = dangerous.map((c) => `\`${renderCommand(c)}\``).join(', ');
    await postToDispatch(
      topic,
      `plan contains destructive ops (${rendered}) — type them explicitly to run.`,
    );
    return;
  }

  if (plan.length === 1) {
    await postToDispatch(topic, `interpreting as \`${renderCommand(plan[0])}\``);
  } else {
    const lines = plan.map((c, i) => `${i + 1}. \`${renderCommand(c)}\``);
    await postToDispatch(topic, [`interpreting as ${plan.length} steps:`, ...lines].join('\n'));
  }
  for (const step of plan) {
    await executeCommand(step, topic);
  }
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

async function dispatchEventMessage(event: any): Promise<void> {
  await handleMessage(event);
  const msgId = event?.message?.id;
  if (typeof msgId === 'number' && msgId > lastHandledMessageId) {
    lastHandledMessageId = msgId;
  }
}

// After re-registering (queue death), fetch any messages that arrived in
// the gap and replay them through handleMessage. Bookmark advances inside
// dispatchEventMessage so successive re-registers don't re-replay.
async function catchUpMissedMessages(): Promise<void> {
  if (lastHandledMessageId === 0) return; // first ever register; nothing to catch up
  let missed: any[];
  try {
    missed = await fetchMessagesSince({ zulip, sinceMessageId: lastHandledMessageId });
  } catch (err: any) {
    log(`catch-up fetch failed (proceeding without): ${err.message}`);
    return;
  }
  if (missed.length === 0) return;
  log(`replaying ${missed.length} message${missed.length === 1 ? '' : 's'} missed during queue gap (since msg ${lastHandledMessageId})`);
  for (const message of missed) {
    try {
      await dispatchEventMessage({ message });
    } catch (err: any) {
      log(`catch-up replay error on msg ${message.id}: ${err.message}`);
    }
  }
}

while (running) {
  try {
    const data = await zulip('/events', {
      params: { queue_id: queueId!, last_event_id: lastEventId },
      signal: pollAbort.signal,
    });
    for (const event of data.events) {
      lastEventId = Math.max(lastEventId, event.id);
      try {
        if (event.type === 'message') await dispatchEventMessage(event);
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
        await catchUpMissedMessages();
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
