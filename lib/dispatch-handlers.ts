// Fleet-ops command handlers — the cmd* functions invoked by parsed
// #Dispatch commands (and the NL fallback). Extracted from dispatcher.ts
// so the dispatcher entry point can focus on the supervisor lifecycle
// (event loop, child process management, idle sweep) and route through
// `executeCommand` / `postToDispatch` returned here.
//
// Style: factory closure over a `DispatchCtx`, matching spawn-orchestrator
// and heartbeat. Each cmd is a private function inside the closure;
// the only exports are `executeCommand` and `postToDispatch`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBotSettings } from './bot-settings.ts';
import type { Command } from './commands.ts';
import { humanDuration } from './format.ts';
import type { BotStateStore } from './state.ts';
import type { Bot, Subprocess, WakeTrigger } from './types.ts';
import type { ZulipClient } from './zulip.ts';
import {
  createChannelFolder,
  findFolderByName,
  getStreamId,
  listChannelFolders,
  setStreamFolder,
  setStreamPin,
} from './zulip-admin.ts';

export type DispatchCtx = {
  zulip: ZulipClient;
  zulipAsOwner: ZulipClient | null;
  log: (...parts: unknown[]) => void;
  registry: Record<string, Bot>;
  saveRegistry: (reg: Record<string, Bot>) => void;
  runningBots: Map<string, Subprocess>;
  startTimes: Map<string, number>;
  isAlive: (name: string) => boolean;
  maybeSpawn: (bot: Bot, trigger: WakeTrigger) => Promise<void>;
  stateStore: BotStateStore;
  configDirFor: (bot: Bot) => string;
  ownerUserId: number;
  dispatchBotUserId: number;
  hookScriptPath: string;
  dispatchStream: string;
  fleetRoot: string;
  retiredRoot: string;
  logDir: string;
};

export type DispatchHandlers = {
  executeCommand(cmd: Exclude<Command, { kind: 'unknown' }>, topic: string): Promise<void>;
  postToDispatch(topic: string, content: string): Promise<void>;
};

export function makeDispatchHandlers(ctx: DispatchCtx): DispatchHandlers {
  const {
    zulip, zulipAsOwner, log, registry, saveRegistry, runningBots, startTimes,
    isAlive, maybeSpawn, stateStore, configDirFor, ownerUserId, dispatchBotUserId,
    hookScriptPath, dispatchStream, fleetRoot, retiredRoot, logDir,
  } = ctx;

  async function postToDispatch(topic: string, content: string): Promise<void> {
    try {
      await zulip('/messages', {
        method: 'POST',
        params: { type: 'stream', to: dispatchStream, topic, content },
      });
    } catch (err: any) {
      log(`failed to post to #${dispatchStream}: ${err.message}`);
    }
  }

  // ---------- Lifecycle ----------

  async function cmdSpinUp(topic: string, name: string): Promise<void> {
    const bot = registry[name];
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
    const bot = registry[name];
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
    const bot = registry[name];
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

    const state = stateStore.read(bot.name);
    state.session_id = null;
    stateStore.write(state);

    await postToDispatch(
      topic,
      `@${bot.name} reset — session cleared; the next start will be a fresh conversation`,
    );
  }

  // ---------- Provisioning + retire helpers ----------

  // /bots rejects bot callers, so this single call uses the owner's user creds.
  // /bots response shape varies across Zulip versions (some omit `email`), so we
  // look it up via /users/{id} for the authoritative record.
  async function provisionBotUser(name: string): Promise<{ user_id: number; email: string; api_key: string }> {
    if (!zulipAsOwner) {
      throw new Error('OWNER_API_KEY not configured. Add OWNER_EMAIL and OWNER_API_KEY to .env.');
    }
    // Zulip auto-appends `-bot@<realm>` to short_name; passing `<name>-bot`
    // produces `<name>-bot-bot@…`. Pass the bare name.
    const created = await zulipAsOwner('/bots', {
      method: 'POST',
      params: { full_name: `${name}-bot`, short_name: name, bot_type: 1 },
    });
    if (typeof created.user_id !== 'number' || !created.api_key) {
      throw new Error(`unexpected /bots response: ${JSON.stringify(created)}`);
    }
    const userInfo = await zulip(`/users/${created.user_id}`);
    const email = userInfo.user?.email;
    if (typeof email !== 'string' || email.length === 0) {
      throw new Error(`bot created (user_id ${created.user_id}) but /users lookup returned no email`);
    }
    return { user_id: created.user_id, email, api_key: created.api_key };
  }

  // dispatch-bot must be in `principals` explicitly: when /subscriptions is
  // called with `principals` set, Zulip subscribes only those users — the
  // API caller is NOT auto-added. Without this, dispatch-bot's event queue
  // never sees messages in the new home stream and inbounds vanish silently.
  // (Earlier code/comment claimed auto-subscribe; that's only true when
  // `principals` is omitted entirely. Confirmed by hitting it on #landfall.)
  async function provisionHomeStream(name: string, botUserId: number): Promise<void> {
    await zulip('/users/me/subscriptions', {
      method: 'POST',
      params: {
        subscriptions: [{ name }],
        principals: [ownerUserId, botUserId, dispatchBotUserId],
      },
    });
  }

  function scaffoldWorkingTree(name: string, cwd: string): void {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, 'CLAUDE.md'), claudeMdStub(name));
    // Permissions allowlist + Stop hook to enforce send (see bot-settings.ts).
    ensureBotSettings({ cwd, hookScriptPath });
  }

  async function cmdCreate(
    topic: string,
    name: string,
    opts: { configDir?: string; noSpin?: boolean; auto?: boolean; yolo?: boolean } = {},
  ): Promise<void> {
    const { configDir, noSpin = false, auto = false, yolo = false } = opts;
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      return postToDispatch(topic, `invalid name \`${name}\` — must start with a lowercase letter and contain only [a-z0-9_-]`);
    }
    if (registry[name]) {
      return postToDispatch(topic, `\`${name}\` already in registry; pick a different name or \`retire\` it first`);
    }

    await postToDispatch(topic, `creating @${name}…`);

    let botUser: { user_id: number; email: string; api_key: string };
    try {
      botUser = await provisionBotUser(name);
    } catch (err: any) {
      return postToDispatch(topic, `failed to create bot user: ${err.message}`);
    }
    log(`@${name}: created bot user (user_id ${botUser.user_id}, email ${botUser.email})`);

    try {
      await provisionHomeStream(name, botUser.user_id);
    } catch (err: any) {
      return postToDispatch(
        topic,
        `bot user created but stream creation failed: ${err.message}. orphan bot user_id=${botUser.user_id}, email=${botUser.email} — deactivate manually or call \`retire\` after manually adding it to the registry`,
      );
    }
    log(`@${name}: stream #${name} ready, subscribers include owner + new bot + dispatch-bot`);

    // Pretrust happens at spawn time now (see spawnBot), so we don't repeat
    // it here — the working tree won't be entered by Claude until first wake.
    const cwd = join(fleetRoot, name);
    try {
      scaffoldWorkingTree(name, cwd);
    } catch (err: any) {
      return postToDispatch(topic, `stream OK but working tree scaffold failed: ${err.message}`);
    }
    log(`@${name}: scaffolded working tree at ${cwd}`);

    const entry: Bot = {
      name,
      home_stream: name,
      cwd,
      bot_email: botUser.email,
      bot_api_key: botUser.api_key,
    };
    if (configDir) entry.config_dir = configDir;
    if (auto) entry.auto = true;
    if (yolo) entry.yolo = true;
    registry[name] = entry;
    saveRegistry(registry);

    const lines = [
      `✓ @${name} created`,
      `- bot user: \`${botUser.email}\` (user_id ${botUser.user_id})`,
      `- home stream: \`#${name}\``,
      `- working tree: \`${cwd}\``,
    ];
    if (configDir) lines.push(`- config dir: \`${configDir}\` (per-bot override)`);
    if (yolo) lines.push(`- mode: **yolo** (\`--dangerously-skip-permissions\`, all prompts bypassed)`);
    else if (auto) lines.push(`- mode: **auto** (non-danger prompts auto-approved; danger prompts still ask)`);
    if (noSpin) {
      lines.push(`Run \`spin up ${name}\` and tell it what kind of bot to be.`);
      await postToDispatch(topic, lines.join('\n'));
      return;
    }
    lines.push(`Spinning up @${name} now — say what kind of bot it should be in #${name}.`);
    await postToDispatch(topic, lines.join('\n'));
    await cmdSpinUp(topic, name);
  }

  async function cmdUpdate(
    topic: string,
    name: string,
    opts: { configDir?: string; clearConfig?: boolean; auto?: boolean; yolo?: boolean },
  ): Promise<void> {
    const bot = registry[name];
    if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);

    const hasFlag =
      opts.configDir !== undefined ||
      opts.clearConfig === true ||
      opts.auto !== undefined ||
      opts.yolo !== undefined;

    // No flags → show current settings for this bot.
    if (!hasFlag) {
      const effective = configDirFor(bot);
      const overridden = bot.config_dir ? ' (per-bot override)' : ' (global default)';
      const mode = bot.yolo ? 'yolo' : bot.auto ? 'auto' : 'prompt';
      return postToDispatch(
        topic,
        `@${name} config dir: \`${effective}\`${overridden}; mode: **${mode}**`,
      );
    }

    if (opts.configDir && opts.clearConfig) {
      return postToDispatch(topic, `\`--config\` and \`--clear-config\` are mutually exclusive`);
    }

    const configChanged = opts.configDir !== undefined || opts.clearConfig === true;
    if (opts.clearConfig) {
      delete bot.config_dir;
    } else if (opts.configDir) {
      bot.config_dir = opts.configDir;
    }
    if (opts.auto === true) bot.auto = true;
    else if (opts.auto === false) delete bot.auto;
    if (opts.yolo === true) bot.yolo = true;
    else if (opts.yolo === false) delete bot.yolo;
    saveRegistry(registry);

    // Only a config-dir change requires clearing session_id (jsonls live under
    // the old config dir; --resume from the new dir would 404). auto/yolo
    // don't move session storage, so the resume chain survives.
    if (configChanged) {
      const state = stateStore.read(name);
      state.session_id = null;
      stateStore.write(state);
    }

    const effective = configDirFor(bot);
    const mode = bot.yolo ? 'yolo' : bot.auto ? 'auto' : 'prompt';
    const sessionNote = configChanged ? ' Session cleared (next start is fresh).' : '';
    const liveNote = isAlive(name)
      ? ` Running session keeps the old settings until you \`reset ${name}\` or it dies.`
      : '';
    await postToDispatch(
      topic,
      `@${name} updated → config dir \`${effective}\`, mode **${mode}**.${sessionNote}${liveNote}`,
    );
  }

  // Retire steps. Each handles its own failure mode: SIGTERM-and-wait for the
  // child, log-and-continue for Zulip API failures, return null on archive
  // failure so the caller can mention "left in place" in the result message.
  // All log under the bot's name for grep-ability.

  async function killIfRunning(bot: Bot): Promise<void> {
    const child = runningBots.get(bot.name);
    if (!child) return;
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

  async function lookupBotUserId(bot: Bot): Promise<number | null> {
    if (!bot.bot_email) {
      log(`@${bot.name} retire: bot_email missing from registry — skipping user lookup`);
      return null;
    }
    try {
      const res = await zulip(`/users/${encodeURIComponent(bot.bot_email)}`);
      return res.user?.user_id ?? null;
    } catch (err: any) {
      log(`@${bot.name} retire: couldn't look up user_id: ${err.message}`);
      return null;
    }
  }

  // Zulip's DELETE /users/<id> only handles human users — bots use /bots/<id>
  // instead. dispatch-bot's admin role is sufficient. Reversible; preserves history.
  async function deactivateBotUser(bot: Bot, userId: number): Promise<void> {
    try {
      await zulip(`/bots/${userId}`, { method: 'DELETE' });
      log(`@${bot.name} retire: deactivated bot user_id ${userId}`);
    } catch (err: any) {
      log(`@${bot.name} retire: deactivation failed: ${err.message}`);
    }
  }

  // Archives the stream (reversible by admin; messages preserved).
  async function archiveHomeStream(bot: Bot): Promise<void> {
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
  }

  // Move the working tree under _retired/ so the main fleet dir stays clean.
  // Returns the archived path (or null on failure). Timestamped so re-creating
  // + re-retiring the same name doesn't clobber prior archives.
  function archiveWorkingTree(bot: Bot, name: string): string | null {
    if (!existsSync(bot.cwd)) return null;
    try {
      mkdirSync(retiredRoot, { recursive: true });
      // Colons stripped for FS safety: 2026-05-07T20-58-30Z
      const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+/, '');
      const archivedPath = join(retiredRoot, `${ts}_${name}`);
      renameSync(bot.cwd, archivedPath);
      log(`@${bot.name} retire: moved working tree to ${archivedPath}`);
      return archivedPath;
    } catch (err: any) {
      log(`@${bot.name} retire: failed to archive working tree: ${err.message}`);
      return null;
    }
  }

  async function cmdRetire(topic: string, name: string): Promise<void> {
    const bot = registry[name];
    if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);

    await postToDispatch(topic, `retiring @${name}…`);

    await killIfRunning(bot);
    const userId = await lookupBotUserId(bot);
    if (userId !== null) await deactivateBotUser(bot, userId);
    await archiveHomeStream(bot);

    delete registry[name];
    saveRegistry(registry);

    const archivedPath = archiveWorkingTree(bot, name);
    const archiveLine = archivedPath
      ? `Working tree archived to \`${archivedPath}\` — \`mv\` it back to unretire.`
      : `Working tree at \`${bot.cwd}\` left in place (archive failed; rm or move manually).`;
    await postToDispatch(
      topic,
      `✓ @${name} retired (bot deactivated, stream archived, registry cleared). ${archiveLine}`,
    );
  }

  // ---------- Inspection ----------

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
    const targets = name ? [name] : Object.keys(registry);
    const lines: string[] = [];
    for (const n of targets) {
      const bot = registry[n];
      if (!bot) {
        lines.push(`- \`${n}\`: not in registry`);
        continue;
      }
      const state = stateStore.read(bot.name);
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
    const bot = registry[name];
    if (!bot) return postToDispatch(topic, `no bot named \`${name}\` in registry`);
    const path = join(logDir, `${bot.name}.log`);
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

  // ---------- Sidebar / folders (owner-cred operations) ----------

  // pin_to_top is per-user: we want it pinned in *the operator's* sidebar,
  // not dispatch-bot's. Same applies to channel folder ops below.
  async function cmdPin(topic: string, streamName: string, value: boolean): Promise<void> {
    if (!zulipAsOwner) {
      return postToDispatch(topic, `OWNER_API_KEY not configured — pin/unpin needs owner creds.`);
    }
    try {
      const id = await getStreamId(zulipAsOwner, streamName);
      await setStreamPin(zulipAsOwner, id, value);
      await postToDispatch(topic, `${value ? 'pinned' : 'unpinned'} #${streamName}`);
    } catch (err: any) {
      await postToDispatch(topic, `${value ? 'pin' : 'unpin'} failed: ${err.message}`);
    }
  }

  async function cmdCreateFolder(topic: string, name: string, description?: string): Promise<void> {
    if (!zulipAsOwner) {
      return postToDispatch(topic, `OWNER_API_KEY not configured — channel-folder ops need owner creds.`);
    }
    try {
      // Idempotency: if a folder by this name already exists, don't double-create.
      const existing = await findFolderByName(zulipAsOwner, name);
      if (existing) {
        return postToDispatch(topic, `folder \`${name}\` already exists (id ${existing.id})`);
      }
      const id = await createChannelFolder(zulipAsOwner, name, description);
      await postToDispatch(topic, `created folder \`${name}\` (id ${id})`);
    } catch (err: any) {
      await postToDispatch(topic, `create folder failed: ${err.message}`);
    }
  }

  async function cmdListFolders(topic: string): Promise<void> {
    if (!zulipAsOwner) {
      return postToDispatch(topic, `OWNER_API_KEY not configured — channel-folder ops need owner creds.`);
    }
    try {
      const folders = await listChannelFolders(zulipAsOwner);
      const live = folders.filter((f) => !f.is_archived);
      if (live.length === 0) return postToDispatch(topic, `no channel folders`);
      const lines = live.map((f) => `- \`${f.name}\` (id ${f.id})${f.description ? ` — ${f.description}` : ''}`);
      await postToDispatch(topic, ['**channel folders:**', ...lines].join('\n'));
    } catch (err: any) {
      await postToDispatch(topic, `list folders failed: ${err.message}`);
    }
  }

  async function cmdSetFolder(topic: string, streamName: string, folderName: string): Promise<void> {
    if (!zulipAsOwner) {
      return postToDispatch(topic, `OWNER_API_KEY not configured — channel-folder ops need owner creds.`);
    }
    try {
      const folder = await findFolderByName(zulipAsOwner, folderName);
      if (!folder) {
        return postToDispatch(topic, `no folder named \`${folderName}\` — try \`list folders\` or \`create folder ${folderName}\``);
      }
      const streamId = await getStreamId(zulipAsOwner, streamName);
      await setStreamFolder(zulipAsOwner, streamId, folder.id);
      await postToDispatch(topic, `moved #${streamName} into folder \`${folder.name}\``);
    } catch (err: any) {
      await postToDispatch(topic, `set folder failed: ${err.message}`);
    }
  }

  async function cmdClearFolder(topic: string, streamName: string): Promise<void> {
    if (!zulipAsOwner) {
      return postToDispatch(topic, `OWNER_API_KEY not configured — channel-folder ops need owner creds.`);
    }
    try {
      const id = await getStreamId(zulipAsOwner, streamName);
      await setStreamFolder(zulipAsOwner, id, null);
      await postToDispatch(topic, `removed #${streamName} from its folder`);
    } catch (err: any) {
      await postToDispatch(topic, `clear folder failed: ${err.message}`);
    }
  }

  async function cmdHelp(topic: string): Promise<void> {
    // Each row pairs the canonical form with its aliases (parseCommand accepts
    // any of them). Kept in sync with lib/commands.ts ALIASES manually.
    const rows: Array<[string, string, string?]> = [
      ['spin up @<bot>', 'start that bot (resumes prior session if known)', 'wake, wake up, start'],
      ['shut down @<bot>', 'kill that bot (next start will resume)', 'stop, kill'],
      ['reset @<bot>', 'kill and clear stored session; next start is fresh'],
      ['create <name> [--config <path>] [--no-spin] [--auto] [--yolo]', 'provision a new bot end-to-end and spin it up. --auto = auto-approve non-danger prompts. --yolo = pass --dangerously-skip-permissions (bypasses ALL prompts including danger).', 'create-bot'],
      ['update <name> [--config <path> | --clear-config] [--auto | --no-auto] [--yolo | --no-yolo]', 'change a bot\'s per-bot settings (config change clears session; auto/yolo apply on next spawn)'],
      ['retire <name>', 'kill, deactivate Zulip bot, archive stream, remove from registry'],
      ['list active', 'running bots + uptime', 'list'],
      ['status [@<bot>]', 'alive/sleeping + last activity (all bots if no name)'],
      ['logs @<bot> [n]', 'last n lines of bot stdout/stderr (default 30)', 'log'],
      ['pin <stream>', 'pin the stream to the top of your sidebar'],
      ['unpin <stream>', 'unpin the stream'],
      ['create folder <name>', 'create a channel folder', 'create-folder'],
      ['list folders', 'list channel folders', 'list-folders'],
      ['set folder <stream> <folder>', 'move a stream into a folder', 'set-folder'],
      ['clear folder <stream>', 'remove a stream from its folder', 'clear-folder'],
      ['help', 'this'],
    ];
    const body = rows.map(([cmd, desc, aliases]) => {
      const tail = aliases ? ` _(aliases: ${aliases})_` : '';
      return `- \`${cmd}\` — ${desc}${tail}`;
    });
    await postToDispatch(topic, ['**fleet ops:**', ...body].join('\n'));
  }

  function executeCommand(cmd: Exclude<Command, { kind: 'unknown' }>, topic: string): Promise<void> {
    switch (cmd.kind) {
      case 'spinUp':       return cmdSpinUp(topic, cmd.target);
      case 'shutDown':     return cmdShutDown(topic, cmd.target);
      case 'reset':        return cmdReset(topic, cmd.target);
      case 'create':       return cmdCreate(topic, cmd.target, {
        configDir: cmd.configDir,
        noSpin: cmd.noSpin ?? false,
        auto: cmd.auto ?? false,
        yolo: cmd.yolo ?? false,
      });
      case 'update':       return cmdUpdate(topic, cmd.target, cmd);
      case 'retire':       return cmdRetire(topic, cmd.target);
      case 'listActive':   return cmdListActive(topic);
      case 'status':       return cmdStatus(topic, cmd.target);
      case 'logs':         return cmdLogs(topic, cmd.target, cmd.n);
      case 'pin':          return cmdPin(topic, cmd.target, true);
      case 'unpin':        return cmdPin(topic, cmd.target, false);
      case 'createFolder': return cmdCreateFolder(topic, cmd.name, cmd.description);
      case 'listFolders':  return cmdListFolders(topic);
      case 'setFolder':    return cmdSetFolder(topic, cmd.stream, cmd.folder);
      case 'clearFolder':  return cmdClearFolder(topic, cmd.stream);
      case 'help':         return cmdHelp(topic);
    }
  }

  return { executeCommand, postToDispatch };
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
