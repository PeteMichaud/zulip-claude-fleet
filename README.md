# zulip-claude-fleet

Talk to a fleet of Claude Code agents through Zulip streams — one bot per stream — instead of cycling terminal tabs.

Each bot is a long-running Claude session living in its own Zulip stream. A dispatcher process spawns the session on first message, supervises it as a child process, and resumes its conversation across restarts so context survives sleep/wake cycles. Permission prompts (Bash, Write, Edit) get relayed to Zulip with tap-to-approve emoji reactions, so you can drive the fleet from your phone without baby-sitting a terminal.

## What it actually looks like

In `#Dispatch`:

```
you:         create writer
@dispatch:   ✓ @writer created
             - bot user: writer-bot-bot@your-realm.zulipchat.com
             - home stream: #writer
             - working tree: ~/claude-fleet/writer
```

In `#writer`:

```
you:         you're a technical writer focused on tight prose. Edit your
             CLAUDE.md to reflect that, then ask dispatch to reset you.
@writer:     [writes CLAUDE.md] [posts "reset writer" in #Dispatch]
@dispatch:   @writer reset; next start is fresh
you:         ok, here's a draft I want feedback on…
@writer:     [edit notes]
```

## Quickstart

Requires macOS (Linux probably works; Windows doesn't — see roadmap), [Bun](https://bun.sh) ≥ 1.x, [Claude Code](https://code.claude.com) ≥ 2.1.80, Python 3 (preinstalled on macOS).

**Zulip side** (one-time):

1. Create or join a Zulip realm — Zulip Cloud's free tier works.
2. Personal Settings → Bots → create a generic bot named `dispatch-bot`. Save its email and API key.
3. Manage organization → Users → set `dispatch-bot`'s role to **Organization administrator**. Required for stream creation with multi-user subscriptions, user deactivation, and stream archival. *Note: even with admin, bot users can't create other bots — Zulip's `/bots` endpoint refuses bot callers regardless of role. The dispatcher uses your personal user creds for that one specific call (see `OWNER_*` in `.env.example`).*
4. Create the `#Dispatch` stream. Subscribe yourself + dispatch-bot.

**Local side**:

```
git clone https://github.com/PeteMichaud/zulip-claude-fleet.git
cd zulip-claude-fleet
bun install
cp shared-mcp.json.example shared-mcp.json   # edit the absolute path inside
cp .env.example .env                          # fill in credentials
```

`.env` needs `DISPATCH_BOT_*` (the bot you just made) and `OWNER_*` (your personal Zulip user creds — Zulip's `/bots` endpoint refuses bot callers, so the dispatcher uses your account for that one specific call).

**Run** (in a tmux pane or persistent terminal — the dispatcher needs to stay up):

```
bun run dispatcher
```

Then, in `#Dispatch` from your Zulip client:

- `help` — full command list (with aliases)
- `create <name> [--config <path>]` — provision a new bot end-to-end
- `update <name> --config <path>` — change a bot's per-bot Claude config dir
- `spin up <name>` / `shut down <name>` / `reset <name>` — lifecycle
- `retire <name>` — fully decommission

Test coverage and known gaps: [TESTING.md](TESTING.md).

## Status

End-to-end working:

- **JIT spawn** — bot wakes when you message it.
- **Lifecycle commands** — `spin up` / `shut down` / `reset` / `status` / `logs` / `list active`.
- **Persistent conversation continuity** via `claude --resume` so context survives sleep/wake.
- **Fully automated `create` / `retire`** — no manual Zulip UI steps.
- **Per-bot Claude config dir** — `create writer --config ~/.claude-mimo` (or `update`) so a single fleet can mix bots running under different Claude profiles.
- **Permission relay** with emoji reactions and a danger-pattern carve-out for things like `rm -rf`.
- **Inter-bot @-mention relay** — `@editor` in `#writer` summons editor and reply lands back in `#writer` without subscribing every bot to every stream.
- **Idle auto-shutdown** after 30 minutes of inactivity.

48 unit tests cover the pure helpers (command parsing, formatting, permission logic, Zulip client). Integration paths (process supervision, MCP wiring, real Zulip behavior) are manually verified by running through the quickstart above — see TESTING.md for what's covered vs. deferred.

## Roadmap

- **Cross-platform.** macOS verified. Linux probably fine (POSIX paths + Python's `pty` is Unix-only but works there). Windows currently broken: `scripts/pty-helper.py` relies on Unix PTY APIs. Either fix `node-pty`'s `posix_spawnp` failure (we hit it on macOS during the build but didn't fully diagnose) or write a Windows-specific spawn path.
- **Smarter dispatcher.** The dispatcher's command grammar is hand-coded regex. A meta-Claude *inside* `@dispatch-bot` could interpret natural-language requests ("spin up a Python expert that handles refactoring questions, name it pyrefactor") and translate them into structured calls. Removes the need to extend the parser for every new operation.
- **Handoff on shutdown.** `shut down` and `compact` don't auto-invoke the `/handoff` skill to capture tacit state — `--resume` carries conversation history but not the latent stuff (working hypotheses, ruled-out approaches, "what was I about to do"). Brittle to implement (the dispatcher has to instruct Claude to write the file, then wait for completion or timeout, then kill); deferred for now.
- **Smarter inter-bot loop handling.** The basic @-mention relay ships with a crude rate limit (10 forwards/60s per target) — enough to bound runaway loops but heavy-handed. A real solution tracks mention-chain depth or per-conversation forward graphs.
- **Plugin packaging.** Get the channel server onto Anthropic's `--channels` allowlist so the dispatcher doesn't need `--dangerously-load-development-channels`.

## Why this exists

Anthropic ships official Slack and Telegram channel plugins, plus "Claude on the web" cloud sandboxes. None of those quite hit the use case of "I want N persistent local Claudes for N parallel projects, addressable from anywhere." Zulip's stream model maps neatly to per-bot working contexts (each bot has a stream that doubles as its persistent transcript), and self-host or Zulip Cloud both work. The dispatcher layer adds the lifecycle (spawn, supervise, persist, retire) that the [Channels feature](https://code.claude.com/docs/en/channels) alone doesn't provide.
