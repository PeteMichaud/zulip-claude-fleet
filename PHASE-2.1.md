# Phase 2.1 — Implementation Notes

Concrete plan for the wake-up-only dispatcher slice. Once this builds, the briefing bot auto-spawns when messaged and is supervised as a dispatcher child.

## Layout shift from phase 1

In phase 1 the bot's working tree *is* the project repo — Pete launches Claude in `~/zulip-claude-channel/` and Claude reads the project's `CLAUDE.md` as its persona. That conflation was a phase 1 convenience. 2.1 separates them:

```
~/zulip-claude-channel/      # the system's code
├── zulip-channel.ts          # channel server (existing)
├── dispatcher.ts             # NEW
├── shared-mcp.json           # NEW: --mcp-config for spawned bots
├── scripts/zulip-ping.ts     # existing
├── state/                    # NEW (gitignored): dispatcher state per bot
│   └── briefing.json         #   { session_id, last_active, broken }
├── package.json
├── .env                      # site, owner id, briefing-bot creds (for now)
└── ...

~/briefing/                   # NEW: briefing-bot's working tree
├── CLAUDE.md                 # MOVED from zulip-claude-channel
├── HANDOFF.md                # written by /handoff (lands in 2.3, but tree exists now)
└── ...                       # whatever the bot is working on
```

The bot's working tree is its own domain. Dispatcher `cd`s into it to launch Claude. The project repo is for code; the bot tree is for the bot's actual work product.

## Dispatcher process model

One Bun process. Three logical components in one event loop:

1. **Zulip event listener.** Long-poll on `/events`, narrowed to messages in registered bots' home streams. (2.1: just `briefing`.) Same dual-subscription model as the channel server — they both have their own queues.
2. **Process supervisor.** Spawned Claude sessions are child processes. `SIGCHLD` (or Bun's `subprocess.exited` promise) updates per-bot DEAD/ALIVE state when a child exits.
3. **Per-bot spawn lock.** Mutex per bot serializes spawn attempts. Inbounds arriving mid-spawn queue behind the in-flight one.

No HTTP server. No IPC. Talks to Zulip and to child processes via standard OS primitives.

## State persistence

Per-bot state file at `state/<name>.json`:

```json
{
  "name": "briefing",
  "session_id": null,
  "last_active": "2026-05-06T22:30:00Z",
  "broken": null
}
```

`session_id` will get used by 2.3 (resume); for 2.1, dispatcher updates `last_active` on every inbound and writes the file atomically. `broken` is non-null when spawn-time creds rejection has marked the bot unusable; cleared on next successful spawn.

Registry of bots in 2.1: hardcoded in `dispatcher.ts` (one entry, `briefing`). The fleet-style multi-bot registry lands in 2.4.

## Bootstrap message delivery

The wake-trigger message — the inbound that caused the dispatcher to spawn — has to reach Claude somehow. The dispatcher already consumed it from its own Zulip queue, and the bot's MCP starts with a fresh queue that won't replay past events.

**Mechanism: dispatcher writes a file; channel server reads + replays.**

Before spawning, dispatcher writes `~/briefing/.wake-trigger.json`:

```json
{
  "stream": "briefing",
  "topic": "general chat",
  "sender": "Pete Michaud",
  "content": "<the original message body>"
}
```

The channel server checks for this file at startup. If present, after `mcp.connect()` succeeds, it emits the contents as a channel notification (same shape as a normal inbound from Zulip), then `unlink`s the file.

Why a file:
- Crash-safe: if dispatcher dies mid-spawn, the file is still there for the next attempt.
- Decoupled: dispatcher doesn't need to know Claude's CLI shape.
- Same code path: Claude sees the wake-trigger as a normal `<channel>` event, indistinguishable from steady-state inbound.

## Spawn invocation

Roughly:

```
Bun.spawn({
  cmd: [
    'claude-sfc',
    '--dangerously-load-development-channels', 'server:zulip-channel',
    '--mcp-config', '/Users/pete/zulip-claude-channel/shared-mcp.json',
  ],
  cwd: '/Users/pete/briefing',
  env: {
    ...process.env,
    ZULIP_SITE: '...',
    ZULIP_BOT_EMAIL: 'briefing-bot@petefleet.zulipchat.com',
    ZULIP_API_KEY: '...',
    ZULIP_HOME_STREAM: 'briefing',
    ZULIP_OWNER_USER_ID: '1077319',
  },
  stdin: 'inherit',  // or 'ignore'; needs testing
  stdout: 'pipe',    // captured to log file in state/logs/<name>.log
  stderr: 'pipe',    // same
});
```

Open question: `claude-sfc` is a shell function, not a binary. Bun.spawn invokes commands directly, not through the shell. We'll need either:
- Use `bash -lc 'claude-sfc ...'` to load Pete's shell function, or
- Replicate what `claude-sfc` does (set `CLAUDE_CONFIG_DIR=~/.claude-sfc`, exec `claude`) directly in the spawn call.

The latter is cleaner. Drop `claude-sfc` and set the env var explicitly.

## Shared MCP config

`shared-mcp.json`:

```json
{
  "mcpServers": {
    "zulip-channel": {
      "command": "bun",
      "args": ["run", "/Users/pete/zulip-claude-channel/zulip-channel.ts"]
    }
  }
}
```

Absolute path so it resolves regardless of cwd. The bot's working tree no longer needs its own `.mcp.json` for the channel server — the dispatcher provides it via `--mcp-config`.

## Migration steps from phase 1

1. `mkdir ~/briefing && mv ~/zulip-claude-channel/CLAUDE.md ~/briefing/CLAUDE.md`.
2. Remove `~/zulip-claude-channel/.mcp.json` (it's no longer the source for spawned bots; the file lingering would confuse Claude Code if launched from the project root).
3. Create `~/zulip-claude-channel/shared-mcp.json`.
4. Update `zulip-channel.ts` to handle `.wake-trigger.json` on startup.
5. Write `~/zulip-claude-channel/dispatcher.ts`.
6. Update `.gitignore` for `state/` and `.wake-trigger.json`.
7. Write `RUNBOOK-2.1.md` covering: install dispatcher as launchd/systemd unit (or run in tmux), provision `~/briefing/`, verify wake-on-message works.

## Build order within 2.1

Each step is independently testable.

1. **Wake-trigger handling in channel server.** Add the file-read-and-replay logic. Test by manually dropping `.wake-trigger.json` in `~/briefing/` and launching the channel server directly (no dispatcher yet) — confirm Claude sees the message.
2. **Layout migration.** Move CLAUDE.md, create `~/briefing/`, write `shared-mcp.json`.
3. **Dispatcher skeleton.** Subscribe to Zulip narrowed to `#briefing`, log inbounds, no spawning yet. Verify it sees Pete's messages alongside the running bot's MCP.
4. **Spawn logic.** Add `Bun.spawn` of Claude with full env/cwd/args, write wake-trigger file just before spawn. Test by killing the bot and posting in `#briefing`.
5. **Supervision.** Track child via `subprocess.exited`; mark DEAD on exit; next inbound respawns.
6. **End-to-end test.** Documented in RUNBOOK-2.1.md.

## Failure modes covered in 2.1

- **Dispatcher Zulip creds bad on startup** → log + exit non-zero.
- **Bot Zulip creds bad at spawn time** → spawn fails; dispatcher writes `broken` to state and stops trying for that bot until reset.
- **Spawned Claude exits unexpectedly** → SIGCHLD, mark DEAD, no auto-restart loop. Next inbound triggers respawn.

Permission-relay-timeout, compact-wedge, dispatcher-crash-recovery — all deferred to later slices per spec.

## Open questions for implementation time

- **`claude-sfc` vs setting `CLAUDE_CONFIG_DIR` directly.** Recommend the latter (no shell function dependency).
- **stdin/stdout/stderr handling.** Claude Code is interactive; if we don't give it a TTY, will it still work? Worth testing whether `pipe`/`ignore` for stdin breaks the channel-MCP flow. Fallback: spawn under `script -q` or `pty.js` to give it a pseudo-TTY.
- **Where dispatcher logs go.** `state/logs/<name>.log` per bot, plus a top-level `state/dispatcher.log`. Rotate manually; cron isn't worth setting up yet.
- **How to run the dispatcher itself.** `bun run dispatcher.ts` in tmux for now. launchd/systemd unit later.
