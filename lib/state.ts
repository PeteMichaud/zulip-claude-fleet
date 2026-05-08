// Per-bot persistent state: last_active timestamp, resume session_id, and a
// "broken" flag for cred failures. State files live under `<baseDir>/<bot>.json`
// and are written atomically via rename.
//
// Extracted from dispatcher.ts so callers (and tests) can construct a store
// against a tmp directory without booting the whole dispatcher.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type BotState = {
  name: string;
  last_active: string | null;
  session_id: string | null;
  broken: string | null;
};

export type BotStateStore = {
  read(botName: string): BotState;
  write(state: BotState): void;
  bumpActivity(botName: string, now?: Date): void;
};

export function makeBotStateStore(opts: {
  baseDir: string;
  log?: (...parts: unknown[]) => void;
}): BotStateStore {
  const log = opts.log ?? (() => {});

  function statePath(botName: string) {
    return join(opts.baseDir, `${botName}.json`);
  }

  function read(botName: string): BotState {
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

  function write(state: BotState) {
    const path = statePath(state.name);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, path);
  }

  function bumpActivity(botName: string, now: Date = new Date()) {
    const state = read(botName);
    state.last_active = now.toISOString();
    write(state);
  }

  return { read, write, bumpActivity };
}

// Pure predicate: is a bot's state past the idle threshold? Returns false for
// null/unparseable timestamps (treat as "no activity recorded — don't kill").
export function isIdle(opts: {
  lastActive: string | null;
  thresholdMs: number;
  now: number;
}): boolean {
  if (!opts.lastActive) return false;
  const lastMs = Date.parse(opts.lastActive);
  if (Number.isNaN(lastMs)) return false;
  return opts.now - lastMs >= opts.thresholdMs;
}
