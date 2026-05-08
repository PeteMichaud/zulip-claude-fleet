// Watches the bot's session JSONL directory and fires onActivity whenever
// the most-recently-modified jsonl in that dir grows. Used by the channel
// server's heartbeat to distinguish "Claude is actively writing" from
// "Claude has gone quiet" — the difference between 🛠️ and ⌛ on the inbound.
//
// We don't tail a specific file because:
//   - On `claude --resume <sid>`, the existing jsonl is appended to.
//   - On a fresh session, Claude creates a new jsonl with a fresh sid.
//   - Either way, "the most-recently-touched .jsonl in <projects>/<encoded-cwd>/"
//     is the right answer.
// Polling mtime is sufficient — we don't care about the contents, only that
// SOMETHING was written. fs.watch on macOS is finicky enough that polling
// at 2s is more reliable for a coarse heartbeat signal.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ActivityWatcher = {
  stop(): void;
};

export function startJsonlActivityWatcher(opts: {
  projectsDir: string;
  onActivity: () => void;
  pollMs?: number;
  log?: (...parts: unknown[]) => void;
}): ActivityWatcher {
  const pollMs = opts.pollMs ?? 2000;
  const log = opts.log ?? (() => {});

  function maxMtime(): number {
    if (!existsSync(opts.projectsDir)) return 0;
    let latest = 0;
    let entries: string[];
    try {
      entries = readdirSync(opts.projectsDir);
    } catch {
      return 0;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const m = statSync(join(opts.projectsDir, f)).mtimeMs;
        if (m > latest) latest = m;
      } catch {
        // Race: file may have been replaced between readdir and stat. Skip.
      }
    }
    return latest;
  }

  // Seed lastSeen at the current state so we don't fire on the existing file
  // that was already there before we started watching (e.g., on --resume the
  // jsonl already exists with prior content).
  let lastSeen = maxMtime();
  log(`jsonl-tail: watching ${opts.projectsDir} (initial mtime ${lastSeen})`);

  const timer = setInterval(() => {
    const latest = maxMtime();
    if (latest > lastSeen) {
      lastSeen = latest;
      try {
        opts.onActivity();
      } catch (err: any) {
        log('jsonl-tail: onActivity threw:', err.message);
      }
    }
  }, pollMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
