# zulip-claude-channel

Talk to a fleet of Claude Code agents through Zulip streams — one bot per stream — instead of cycling terminal tabs.

Each bot is a long-running Claude session living in its own Zulip stream. A dispatcher process spawns the session on first message, supervises it as a child process, and resumes its conversation across restarts so context survives sleep/wake cycles. Permission prompts (Bash, Write, Edit) get relayed to Zulip with tap-to-approve emoji reactions, so you can drive the fleet from your phone without baby-sitting a terminal.

## What it actually looks like

In `#Dispatch`:

```
Pete:        create-bot writer
@dispatch:   ✓ @writer created
             - bot user: writer-bot-bot@petefleet.zulipchat.com
             - home stream: #writer
             - working tree: /Users/pete/claude-fleet/writer
```

In `#writer`:

```
Pete:        you're a technical writer focused on tight prose. Edit your
             CLAUDE.md to reflect that, then ask dispatch to reset you.
@writer:     [writes CLAUDE.md] [posts "reset writer" in #Dispatch]
@dispatch:   @writer reset; next start is fresh
Pete:        ok, here's a draft I want feedback on…
@writer:     [edit notes]
```

## Quickstart

Requires macOS (Linux probably works; Windows doesn't — see roadmap), [Bun](https://bun.sh) ≥ 1.x, [Claude Code](https://code.claude.com) ≥ 2.1.80, Python 3 (preinstalled on macOS).

**Zulip side** (one-time):

1. Create or join a Zulip realm — Zulip Cloud's free tier works.
2. Personal Settings → Bots → create a generic bot named `dispatch-bot`. Save its email and API key.
3. Manage organization → Users → set `dispatch-bot`'s role to **Organization administrator**. (Required for stream creation, user deactivation, and stream archival; see the runbook for the why.)
4. Create the `#Dispatch` stream. Subscribe yourself + dispatch-bot.

**Local side**:

```
git clone https://github.com/PeteMichaud/zulip-claude-channel.git
cd zulip-claude-channel
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

- `help` — full command list
- `create-bot <name>` — provision a new bot end-to-end
- `spin up <name>` / `shut down <name>` / `reset <name>` — lifecycle
- `retire <name>` — fully decommission

Test coverage and known gaps: [TESTING.md](TESTING.md).

## Status

Phase 2.4 done. End-to-end working: JIT spawn, lifecycle commands, persistent conversation continuity via `claude --resume`, fully automated `create-bot` / `retire`, permission relay with emoji reactions and danger-pattern carve-outs.

48 unit tests for pure helpers (command parsing, formatting, permission logic, Zulip client). Integration paths (process supervision, MCP wiring, real Zulip behavior) are manually verified per the runbook — see TESTING.md for what's covered vs. deferred.

## Roadmap

- **Cross-platform.** macOS verified. Linux probably fine (POSIX paths + Python's `pty` is Unix-only but works there). Windows currently broken: `scripts/pty-helper.py` relies on Unix PTY APIs. Either fix `node-pty`'s `posix_spawnp` failure (we hit it on macOS during phase 2.1, didn't fully diagnose) or write a Windows-specific spawn path.
- **Smarter dispatcher.** The dispatcher's command grammar is hand-coded regex. A meta-Claude *inside* `@dispatch-bot` could interpret natural-language requests ("spin up a Python expert that handles refactoring questions, name it pyrefactor") and translate them into structured calls. Removes the need to extend the parser for every new operation.
- **Handoff on shutdown.** `shut down` and `compact` don't auto-invoke the `/handoff` skill to capture tacit state — `--resume` carries conversation history but not the latent stuff (working hypotheses, ruled-out approaches, "what was I about to do"). Brittle to implement (the dispatcher has to instruct Claude to write the file, then wait for completion or timeout, then kill); deferred for now.
- **Inter-bot conversation.** Each bot's channel server would also listen for messages mentioning it across other streams, so `@editor` could be summoned into `#writer` mid-conversation. Needs a fleet roster (so bots discover each other) and loop-hazard mitigation (rate limit / mention-depth cap to prevent two bots ping-ponging forever).
- **Idle shutdown.** Currently bots live until explicit `shut down` or dispatcher restart. A wall-clock-or-tool-activity threshold would auto-park sleeping bots to free token budget.
- **Plugin packaging.** Get the channel server onto Anthropic's `--channels` allowlist so the dispatcher doesn't need `--dangerously-load-development-channels`.

## Why this exists

Anthropic ships official Slack and Telegram channel plugins, plus "Claude on the web" cloud sandboxes. None of those quite hit the use case of "I want N persistent local Claudes for N parallel projects, addressable from anywhere." Zulip's stream model maps neatly to per-bot working contexts (each bot has a stream that doubles as its persistent transcript), and self-host or Zulip Cloud both work. The dispatcher layer adds the lifecycle (spawn, supervise, persist, retire) that the [Channels feature](https://code.claude.com/docs/en/channels) alone doesn't provide.
