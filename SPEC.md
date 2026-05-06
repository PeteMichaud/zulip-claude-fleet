# Zulip ↔ Claude Code Channel — Spec

A custom [Claude Code Channel](https://code.claude.com/docs/en/channels) that bridges a Zulip realm to one or more running Claude Code sessions. Each Claude bot lives in its own Zulip stream; the realm becomes a chat UI over a fleet of Claudes instead of many terminal tabs.

## Goal

Talk to a fleet of Claudes from any Zulip client. Each bot has a distinct identity, a home stream that doubles as its persistent transcript, and can interject in other bots' streams via @-mentions when summoned.

## Background primitives

**Claude Code Channels** (research preview, v2.1.80+):
- A channel is an MCP stdio server that declares `experimental: { 'claude/channel': {} }`.
- Inbound: server calls `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`. Each `meta` key (must be `[A-Za-z0-9_]`) becomes an attribute on a `<channel source="..." ...>` tag injected into Claude's context.
- Outbound: server registers a standard MCP tool (e.g. `send`) that Claude calls.
- Custom (non-allowlisted) channels run via `claude --dangerously-load-development-channels server:<name>`.
- Events only arrive while a Claude Code session is running.

**Zulip primitives we rely on:**
- *Streams* (Zulip's "channels"): bot subscribed to a stream gets all its messages via the events API.
- *@-mentions*: a bot can register a `register` event narrow that delivers any message mentioning it, even in streams it isn't subscribed to.
- *Bot users*: each has its own API key; cheap to provision; appear with their own name/avatar in the UI.
- *History reads*: any user with access to a public stream can fetch its messages on demand.
- *Self-reactions*: a bot can pre-populate emoji reactions on its own messages via the reactions API, so users tap an existing reaction (one tap on mobile) instead of opening the picker.

## Terminology

A few words are overloaded across the systems this spec straddles. To keep things straight:

- **Channel** — always refers to the Claude Code Channels feature (the MCP-based event push). Never used for the Zulip concept.
- **Stream** — always refers to a Zulip stream (which Zulip's own UI sometimes calls a "channel"; we don't).
- **Bot** — refers to the Zulip bot user as a persistent identity (email + API key + home stream). The bot's *Claude session* is a separate, intermittent thing — when the spec says "bots only ever start via the dispatcher" or "the bot is sleeping," it means the Claude session, not the Zulip user (which exists permanently once provisioned).
- **HANDOFF.md** — the file. **`/handoff`** — the skill that writes it. **Handoff** as a verb — the act of writing.

## Phase 1 — Single bot, end-to-end

One Claude, one Zulip bot, one home stream, no dispatcher. Goal: prove the inbound/outbound loop works.

**Components:**
- One MCP server (Bun + `@modelcontextprotocol/sdk`), spawned by Claude Code as a subprocess via `.mcp.json`.
- Config via env: `ZULIP_SITE`, `ZULIP_BOT_EMAIL`, `ZULIP_API_KEY`, `ZULIP_HOME_STREAM`, `ZULIP_OWNER_USER_ID`.

**Server behavior:**
1. On startup: validate Zulip credentials by calling a cheap auth-required endpoint (e.g. `/users/me`). If the API key is rejected or the site is unreachable, log clearly and exit non-zero — fail loud, don't degrade silently. On success, open the Zulip event queue (`register`) narrowed to the home stream. Connect MCP over stdio.
2. On Zulip message: drop unless `sender_id == ZULIP_OWNER_USER_ID`. Otherwise emit a channel notification with `content = message.content` and `meta = { stream, topic, sender }`.
3. Expose two tools:
   - `send({ stream?, topic?, text })` — POST to Zulip messages API. Defaults to home stream. If `text` exceeds Zulip's per-message limit (~10k chars), the tool transparently splits it into ordered chunks (`(part 1/N)` prefix) posted sequentially in the same topic; ordering is preserved by awaiting each POST before the next.
   - `read({ stream, limit?, anchor? })` — fetch recent messages from any stream. `limit` defaults to 50, capped at 200 to protect Claude's context. Returned as text.
4. `instructions` string tells Claude its handle, its home stream, and that the inbound `<channel>` tag's `stream`/`topic` attributes are the default reply target.

**Prerequisites in `~/.claude-sfc/`** (or whichever `CLAUDE_CONFIG_DIR` is active): the `/handoff` and `/forget` skills, plus the SessionStart hook that injects `HANDOFF.md` if present. These are user-level config and are inherited by every Claude session, including the bot's. See `~/.claude-sfc/skills/handoff/SKILL.md` and `~/.claude-sfc/hooks/inject-handoff.sh`.

**Run (phase 1 only):**
```
claude --dangerously-load-development-channels server:zulip
```
in a tmux pane. Pete writes in the home stream; bot's Claude sees it; replies appear back in the same stream. (From phase 2 onward, the dispatcher launches Claude sessions; you stop running this directly.)

### Permission relay (phase 1)

The channel server declares the `claude/channel/permission` capability and handles `notifications/claude/channel/permission_request`. When Claude Code wants to run a tool requiring approval (Bash, Write, Edit, etc.), the bot posts a prompt into the home stream and waits for a verdict.

**The notification carries** `request_id` (a five-letter ID Claude Code generates, drawn from `a-z` minus `l` so it can't be misread on a phone), `tool_name`, `description`, and `input_preview` (tool args as JSON, truncated to ~200 chars by Claude Code). The bot includes the `request_id` verbatim in its outgoing prompt so the verdict can echo it.

**Two verdict surfaces, both supported:**
- **Emoji reactions (primary).** Bot posts the prompt and pre-populates ✅ and ❌ reactions on its own message via Zulip's reactions API. User taps one (one-tap on mobile). Bot's event listener picks up the `reaction` event, looks up `message_id → request_id` in an in-memory map, emits the verdict.
- **Typed fallback.** Standard `yes abcde` / `no abcde` text reply. Regex match in the inbound handler emits the verdict before the message reaches Claude.

**Danger-regex carve-out.** Some tool calls bypass the reaction path and require a typed verdict. Implemented as a small pattern list (initially `rm -rf`, `git push --force`, `curl ... | sh`, etc.) checked against `tool_name + input_preview`. When matched, the bot posts the prompt *without* pre-populated reactions; only typed `yes <id>` works. Pattern list is config-driven and easy to grow or shrink.

**Verdict-source gate.** Verdicts are accepted only when the reactor/sender is `ZULIP_OWNER_USER_ID`. This matters in phase 3 when other bots can post in streams: a bot identity must never be able to authorize tool calls.

**Timeout behavior.** Permission requests block until answered — no server-side timeout in phase 1. If Pete never reacts, Claude waits indefinitely. Recovery: react (the request stays valid) or hard-restart the session. Auto-deny-after-N-minutes is a phase-2 nicety.

**Out of scope for phase 1:** other bots, dispatcher, JIT spinup, plugin packaging.

## Phase 2 — Dispatcher + JIT spinup

Goal: Claudes don't have to be running all the time. Sending a message to a sleeping Claude wakes it; idle Claudes shut down.

Phase 2 is a daemon's worth of work, not a script. Building it as four end-to-end testable slices:

- **2.1 — Wake-up only.** Spawn-when-asleep mechanism for one hardcoded bot.
- **2.2 — `@dispatch` as a Zulip bot.** Drive lifecycle from chat.
- **2.3 — Persistent memory across sleep/wake.** `--resume` + handoff continuity.
- **2.4 — Multi-bot fleet.** Registry, provisioning, per-bot variation.

Each slice ships as a working system. The architectural foundation lives in 2.1; later slices add commands, continuity, and multiplicity on top.

### 2.1 — Wake-up only

Standalone dispatcher daemon, hardcoded registry of one bot (the `briefing` bot from phase 1). No `@dispatch` Zulip identity yet, no lifecycle commands. Goal: prove the wake mechanism end-to-end.

**The dispatcher.** A separate always-on process (not an MCP server, not tied to any one Claude session) that:
1. Subscribes to the realm's events for the registered bot.
2. For each inbound message: identifies target bot from recipient/mention. Checks whether that bot's Claude session is currently running.
3. If running: do nothing. The target bot's own channel MCP will receive the message via its own Zulip subscription.
4. If not running: spawn it. Pass the triggering message as the bootstrap prompt so the just-woken Claude has context. Its channel MCP takes over for follow-up messages.

**Architecture (dual subscription + parent-child supervision).** Both the dispatcher and each running bot's channel MCP subscribe to Zulip independently. Zulip events are not exclusive — every event queue gets its own copy. Each side has a different responsibility:

- **Per-bot MCP** (when alive): authoritative for delivering messages to its Claude. Forwards everything addressed to its bot.
- **Dispatcher** (always): watches for messages targeting bots and acts only when the target is *not running*.

The only coordination point is the **wake-trigger message itself**. After the dispatcher sees it and finds the bot dead, the dispatcher spawns the bot and delivers that specific message by passing the text into the spawn invocation (as initial prompt or rendered channel event during attach). The bot's MCP creates its own Zulip event queue at startup; that queue only delivers events from its registration time forward, so the wake-trigger — sent before the queue existed — never appears on it. No dedup needed. After spawn, ongoing delivery flows through the bot's own MCP via its own queue. No Unix socket, no IPC layer; Zulip is the bus.

**Liveness check: dispatcher is parent process.** All bots are spawned by the dispatcher and supervised as its child processes. Alive/dead is whatever the kernel reports via `SIGCHLD` / `waitpid` on Linux, kqueue / `EVFILT_PROC` on macOS. The kernel notifies the dispatcher the instant a child exits, so the dispatcher's view of process state is always current.

**Constraint (from 2.1 onward):** Claude sessions for a bot only ever start via the dispatcher. Manually running `cd ~/briefing && claude-sfc --resume ...` produces a session the dispatcher doesn't know about (its parent-child supervision is blind to it, and the bot's identity may collide with a dispatcher-spawned session). This supersedes phase 1's manual-tmux launch — once the dispatcher exists, you stop running Claude directly.

**Per-bot spawn lock.** If two messages arrive for a sleeping bot in quick succession, the dispatcher must not spawn two Claude processes racing on the same session storage (corrupts state). Per-bot mutex around the spawn path; second message queues behind the first and is delivered to the just-woken session via its channel MCP.

**Residual race (narrow, accepted).** There's a sub-millisecond window during shutdown where the bot's MCP is exiting but the kernel hasn't yet reaped the process and signaled the dispatcher. A message arriving in that window can fall through both queues — the bot's MCP is too far gone to process it, the dispatcher still believes the bot is ALIVE and does nothing. Mitigations:

- **Queue-drain on shutdown.** Bot's MCP, on receiving SIGTERM or `/exit`, stops accepting new MCP work but reads any pending Zulip events from its queue and forwards to Claude before exiting. Shrinks the window from "between message arrival and process reap" to "between SIGTERM and drain-code starting."
- **Accept the rest.** The remaining window is microseconds; if a message is dropped you'll notice (Claude doesn't respond) and re-send.

The dual-subscription model accepts this microsecond loss to keep Zulip as the only message bus; closing it would require dispatcher-as-sole-listener with IPC to bots — a coordination layer the workload doesn't justify.

**Failure handling for 2.1:**

- **Zulip credentials rejected at dispatcher startup.** Same posture as phase 1: log clearly, exit non-zero. The dispatcher is the always-on process; if it can't reach Zulip with valid creds, nothing else works.
- **Spawned Claude exits unexpectedly.** Dispatcher sees the SIGCHLD, marks the bot DEAD, waits for the next inbound to re-spawn. No automatic restart loop.

### 2.2 — `@dispatch` as a Zulip bot

Provision `@dispatch` as its own Zulip bot user (separate API key, dedicated stream e.g. `#dispatch`). The dispatcher subscribes to its own home stream, parses commands, and reports back. Pete can now drive lifecycle from chat.

**Why `@dispatch` is a separate bot, not a feature of `@briefing`:** channel messages arrive as Claude's input (text in the context window), not as commands the dispatcher can act on. Runtime ops therefore need a separate addressable identity that the dispatcher itself owns. See Known concerns: "Slash commands aren't relayable."

**Meta-ops in 2.2:**
- `spin up @briefing` — start that bot's Claude session.
- `shut down @briefing` — kill cleanly.
- `list active` — running bots.
- `status @briefing` — uptime, last activity.
- `logs @briefing` — tail recent activity.

(`reset` and `compact` arrive in 2.3 alongside the memory model.)

**Failure handling additions for 2.2:**

- **Bot Zulip credentials rejected at spawn time.** Spawn fails early; dispatcher reports the failure into the `#dispatch` stream and marks the bot as broken until creds are fixed.

### 2.3 — Persistent memory across sleep/wake

**Memory model.** Two layers:

- **Conversation continuity via `claude --resume <session_id>`.** Dispatcher tracks `session_id` per bot, updated whenever a session ends. On wake, the bot resumes literally where it left off — full conversation, working memory, prior tool outputs. Session storage is on-disk under the active `CLAUDE_CONFIG_DIR` (e.g. `~/.claude-sfc/projects/<encoded-cwd>/`), so resume survives machine reboots and indefinite sleep.
- **Tacit-state continuity via `HANDOFF.md`.** Before clean shutdown (and periodically, e.g. on `compact`), dispatcher invokes the `/handoff` skill that asks the bot to write out everything future-self will need that wouldn't survive auto-compact: half-formed hypotheses, what it was trying to do, things it knows-without-being-told. File lives in the bot's working tree. On wake, the SessionStart hook injects it as bootstrap context.

Which layer is load-bearing depends on the wake type:

- **Normal sleep/wake cycle** (machine off, idle shutdown, etc.): `--resume` carries the work. The conversation is intact; the SessionStart hook still injects `HANDOFF.md`, but it's confirming context that's already there.
- **Compact-and-restart** (`@dispatch compact @briefing`): no `--resume` flag, fresh session. `HANDOFF.md` (just written by the `/handoff` skill the dispatcher invoked) is the only bridge to prior state. This is where it earns its keep.
- **Fresh bot** (lands in 2.4): no resume, no handoff. Just `CLAUDE.md` and whatever the dispatcher passes as the bootstrap prompt.

**New commands in 2.3:**
- `reset @briefing` — kill and restart fresh, no resume (`/clear` equivalent).
- `compact @briefing` — handoff + fresh restart, HANDOFF.md is the bridge.

`shut down` from 2.2 also gets upgraded to invoke `/handoff` before killing.

**Eventual cliff to plan for:** session storage isn't infinite, and contexts can fill faster than they compact. When a session gets oversized or pruned, the dispatcher does a clean `compact` (handoff + fresh restart, no resume) rather than letting Claude Code force its own auto-compact. Threshold and trigger TBD at implementation time.

**Failure handling additions for 2.3:**

- **Permission relay timeout.** Inherits phase 1 behavior (blocks until answered). 2.3 may add a configurable per-bot kill-after-N-minutes that auto-denies and lets the bot continue; default off.
- **Compact wedge.** If `@dispatch compact @briefing` fires `/handoff` and the session never returns (Claude stuck mid-tool, hung, unresponsive), the dispatcher times out after ~2 min, hard-kills, and restarts. Latent state since the last successful handoff is lost; the new session reads the previous `HANDOFF.md`. Wedge recovery prioritizes liveness over fidelity.

### 2.4 — Multi-bot fleet

Now that the wake mechanism, lifecycle commands, and continuity all work for one bot, add the rest of the fleet.

**Bot profile schema.** Each bot is fully described by:

- `name`
- `cwd` (the working tree)
- `zulip_bot_email`, `zulip_api_key`
- `home_stream`

Plus dispatcher-tracked runtime state:

- `session_id` (latest, for `claude --resume`)
- `pid` / process handle (running-or-not, via parent-child supervision)

**The bot's working tree only needs `CLAUDE.md`.** That's the entire per-bot scaffolding. Everything else is either inherited from user-level config, injected at launch by the dispatcher, or partitioned automatically by Claude Code:

- **Inherited from `~/.claude-sfc/`** (or whichever `CLAUDE_CONFIG_DIR` the operator uses): skills (`/handoff`, `/forget`, `/punch-up`, etc.), the SessionStart hook, `effortLevel`, model defaults, and any other user-level settings. No need to copy these into bot trees.
- **Injected at launch by the dispatcher**: Zulip identity via env vars (`ZULIP_BOT_EMAIL`, `ZULIP_API_KEY`, `ZULIP_HOME_STREAM`), the channel MCP definition via `--mcp-config <shared-zulip-mcp.json>`, the session ID via `--resume <session_id>`, and the `--dangerously-load-development-channels server:zulip` flag.
- **Partitioned by cwd automatically**: session storage lives at `<config-dir>/projects/<encoded-cwd>/`, so each bot's session history is naturally isolated by virtue of having a different working directory.

**New commands in 2.4:**

- `create-bot <name>` — `mkdir` the working tree, write a `CLAUDE.md` stub, provision the Zulip bot user and home stream, register in dispatcher state. The CLAUDE.md is hand-written per bot afterward — that's the irreducible work of giving the bot a personality.
- All existing meta-ops (`spin up`, `shut down`, `reset`, `compact`, `list active`, `status`, `logs`) now operate over the fleet.

**Per-bot exceptions, when needed:**

- If a bot needs an extra MCP server (e.g., researcher wants web search), drop a `.mcp.json` in the bot's working tree. Claude Code merges project-level MCP config additively with the dispatcher's `--mcp-config`, so this stays easy.
- If a bot needs a different permission policy (locked-down vs. skip-permissions), drop a `.claude/settings.json` in the working tree to override user-level. Default: don't vary; let everyone inherit the same policy.

**Migration from phase 1:** in phase 1 the channel MCP was registered via a project-local `.mcp.json` in the bot's working tree. From 2.4 onward, the dispatcher injects the channel MCP definition via `--mcp-config <shared-zulip-mcp.json>` so all bots use a single source of truth. Bot-specific `.mcp.json` files can still exist — Claude Code merges them additively — so phase 1's setup keeps working as a per-bot extension point for non-channel MCPs.

**Failure handling additions for 2.4:**

- **Dispatcher crash / restart.** Child Claude processes die with the parent (parent-child supervision). On restart the dispatcher re-reads its persisted state (bot registry, latest `session_id` per bot) and treats every bot as DEAD; bots wake on the next inbound message targeting them. Messages to sleeping bots during the restart window are dropped — accepted, since dispatcher restarts should be rare.

## Phase 3 — Fleet interop

Goal: Claudes can summon and converse with each other.

**Mechanism:** purely through Zulip's existing primitives. No new protocol.
- Each bot's channel MCP also listens for messages narrowed `sender:not-self AND mentions:me`, in addition to its home stream.
- To summon another Claude, a bot sends a normal Zulip message into the target's home stream containing `@target-bot-name`. Target's channel MCP picks it up because it's listening for its own mentions.
- Cross-context: when summoned with insufficient context, a bot uses the `read` tool to fetch the originating stream's recent history.

**Roster discovery:**
- Each bot's `instructions` includes a small per-bot **VIP list** of other bots it should know about by default.
- For anything beyond the VIPs, a `lookup_users({ query? })` tool hits Zulip's `/users` endpoint so bots can discover the rest of the fleet on demand.

**Sender allowlist update:** in phase 3, the gate widens from `{Pete}` to `{Pete} ∪ {fleet bot user IDs}`. Otherwise inter-bot mentions get silently dropped at the gate. Dispatcher publishes the fleet roster as a JSON file at a known path (e.g. `~/.zulip-bots/roster.json`) containing each bot's name, Zulip user ID, and home stream. Each channel MCP reads it on startup; dispatcher rewrites it whenever a bot is created or removed. (Trivial atomic-write pattern: write to `roster.json.tmp`, rename over.)

**Loop hazard (deferred).** Writer @-mentions editor, editor @-mentions writer, ad infinitum is a real failure mode. Initial mitigation is just `instructions` ("don't @-mention back unless you have a question that requires their input") plus the fact that loops are visible in Zulip and easy to break manually. If a concrete loop becomes annoying, fix that concrete case (rate limit, depth cap, refusal-on-trip). Not engineering it upfront.

## Things deliberately out of scope

- Plugin packaging + marketplace submission: the `--dangerously-load-development-channels` path is fine for personal use indefinitely.
- Multi-user / shared realm: this is single-operator (Pete) by design.
- Attachments: pass Zulip-hosted URLs through and let Claude `WebFetch`. No server-side download.

## Known implementation concerns

These are real but not architectural — they're things to handle correctly in code, not to redesign around.

- **Zulip event queue lifecycle.** Event queues expire (~10 min idle by default) and the server may also expire them on its own schedule. Listener must handle `BAD_EVENT_QUEUE_ID` by re-registering and resuming, or the bot goes silently deaf.
- **Message length cap.** Zulip messages are limited to ~10k characters. The `send` tool must transparently chunk longer outputs (or post a summary + a paste-bin / file link), or Claude's verbose replies will get truncated.
- **Streaming vs. final-post.** Claude generates output over seconds; phase 1 posts once at the end. Acceptable; revisit if it feels laggy. Edit-in-place streaming is possible but adds complexity.
- **Concurrent wake.** Two messages arriving for a sleeping bot in quick succession could spawn two Claudes racing on the same session storage. Mitigated by the per-bot spawn lock described in phase 2.
- **Slash commands aren't relayable.** Channel messages arrive *as Claude's input* (text in the context window), not as commands to the Claude Code TUI. Typing `/clear` or `/compact` in Zulip just shows up as a string Claude sees and shrugs at. Runtime ops (clear, compact, restart, tail logs) go through the dispatcher as documented commands.

## Open questions to resolve at implementation time

1. **Bootstrap message delivery (phase 2):** prompt-arg via `claude -p` vs. channel re-inject after attach. (a) is simpler; (b) preserves a uniform "all messages arrive via channel" invariant. Pick when implementing.
2. **Idle-shutdown criterion (phase 2):** wall-clock idle? No-tool-call idle? Explicit dispatcher command only? Probably start with explicit-only and add timer later.
3. **Dispatcher state persistence (phase 2):** the bot registry (name → cwd, Zulip identity) is small but needs to survive restarts; the per-bot `session_id` updates after every session ends. Single JSON file vs. per-bot files vs. SQLite. Single JSON is probably enough for a fleet of <50.
4. **Where session output goes (phase 1):** tmux pane is fine, but if we want to fully detach from terminals, we need a logging strategy. Punt until phase 1 works.
5. **Compact / handoff trigger (phase 2):** explicit dispatcher command only, or also size-based / time-based? Start with explicit; add automation when needed.
