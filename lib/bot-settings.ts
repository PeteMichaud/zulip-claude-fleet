// Idempotent merge of the bot's .claude/settings.local.json. Two callers:
//   - cmdCreate's scaffoldWorkingTree (initial write)
//   - spawnBot before each launch (migration for bots created before a
//     given config field existed — same pattern as pretrustDirectory)
//
// Preserves any unrelated keys the operator may have added by hand (e.g.
// extra `permissions.allow` entries while customizing the bot's persona).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type BotSettings = {
  permissions?: { allow?: string[]; [k: string]: unknown };
  hooks?: Record<string, unknown>;
  [k: string]: unknown;
};

// The `send` tool is the channel server's only way to deliver replies to
// Zulip; we want every bot enforcing it via the Stop hook.
function desiredHooks(hookScriptPath: string): Record<string, unknown> {
  return {
    Stop: [
      {
        hooks: [
          { type: 'command', command: hookScriptPath },
        ],
      },
    ],
  };
}

const REQUIRED_ALLOW = ['mcp__zulip-channel__*'];

export function ensureBotSettings(opts: {
  cwd: string;
  hookScriptPath: string;
}): { changed: boolean; path: string } {
  const path = join(opts.cwd, '.claude', 'settings.local.json');
  let current: BotSettings = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf-8')) as BotSettings;
    } catch {
      // Unparseable → start fresh rather than silently losing whatever was
      // there. Caller will see this in the changed=true write.
      current = {};
    }
  }

  const before = JSON.stringify(current);

  if (!current.permissions || typeof current.permissions !== 'object') {
    current.permissions = {};
  }
  const allow = Array.isArray(current.permissions.allow) ? current.permissions.allow : [];
  for (const required of REQUIRED_ALLOW) {
    if (!allow.includes(required)) allow.push(required);
  }
  current.permissions.allow = allow;

  current.hooks = desiredHooks(opts.hookScriptPath);

  const after = JSON.stringify(current);
  if (after === before) return { changed: false, path };

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n');
  renameSync(tmp, path);
  return { changed: true, path };
}
