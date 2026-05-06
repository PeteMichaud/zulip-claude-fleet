# Phase 1 Runbook

End state: one Claude in a tmux pane, talking to Pete via one Zulip stream, with permission relay working. Roughly a one-evening build.

Each step is marked **[Pete]** (you do it; I can't) or **[Claude]** (I do it from this session when you say go). Sequential — don't skip ahead.

## 0. Decisions

- **Zulip Cloud** assumed. If you want self-hosted instead, say so before step 1; the runbook diverges only at the realm-creation steps.

## 1. Zulip realm + identities **[Pete]**

You need a Zulip realm, your own user, one bot user, and one stream. Plus three values you'll write into the channel server's env.

1. Go to <https://zulip.com/new/> and create a new organization. Name doesn't matter; pick whatever feels right (e.g. `pete-fleet`). Use your real email.
2. After signup, you're logged in as the realm owner. **Note your realm URL** (e.g. `https://pete-fleet.zulipchat.com`) — that's `ZULIP_SITE`.
3. **Find your own user ID:** click your avatar (top-right) → **Personal menu** → **View profile**. The URL is `…/#user/<NUMBER>/…` — that number is `ZULIP_OWNER_USER_ID`. Write it down.
4. **Create the first bot user:**
   - Click avatar → **Personal Settings** → **Bots** → **Add a new bot**.
   - Bot type: **Generic bot**.
   - Name: pick what you want the bot to appear as (e.g. `writer-bot`). Username will be derived (e.g. `writer-bot@pete-fleet.zulipchat.com`).
   - After creation, the bot's **email address** is `ZULIP_BOT_EMAIL` and the **API key** (click the eye icon to reveal) is `ZULIP_API_KEY`. Write both down.
5. **Create the home stream:**
   - Click the gear/settings icon near the channel list → **Create channel** (or use the `+` next to "CHANNELS" in the sidebar).
   - Name it after the bot, e.g. `writer`. Web-public off, invite-only doesn't matter for solo use.
   - **Subscribe the bot to it**: in the channel settings → Subscribers tab → add the bot user by email. The stream name (`writer`) is `ZULIP_HOME_STREAM`.
6. **Sanity check:** post a message in the `writer` stream from your own user. The bot won't reply (it's not running yet) but you should see your message appear.

By the end you should have written down: `ZULIP_SITE`, `ZULIP_OWNER_USER_ID`, `ZULIP_BOT_EMAIL`, `ZULIP_API_KEY`, `ZULIP_HOME_STREAM`.

## 2. Local prerequisites **[Pete]**

Bun is required (the official channel plugins use it; the SDK works with Node too but Bun's the path of least resistance).

```
curl -fsSL https://bun.sh/install | bash
```

Restart your shell or `source ~/.zshrc`. Verify: `bun --version` (should print `1.x.x`).

Claude Code itself is already installed (you're using it) and channels need v2.1.80+ — you're on 2.1.131, so that's fine.

## 3. Project scaffold **[Claude]**

When you say go, I'll create in `~/zulip-claude-channel/`:

- `package.json` — one dep (`@modelcontextprotocol/sdk`)
- `tsconfig.json` — minimal, Bun-compatible
- `.gitignore` — node_modules, .env, HANDOFF.md, .handoffs/
- `zulip-channel.ts` — the channel server (the actual phase-1 implementation per SPEC.md)
- `.mcp.json` — registers `zulip-channel.ts` as the channel MCP server
- `.env.example` — template you'll copy to `.env` and fill in
- `CLAUDE.md` — the bot's identity / role / scope (stub you can edit)

I won't write your real credentials anywhere; that's step 4.

## 4. Wire credentials **[Pete]**

```
cd ~/zulip-claude-channel
cp .env.example .env
# edit .env with the five values you wrote down in step 1
```

Make sure `.env` is in `.gitignore` (I'll set that up in step 3) so you don't accidentally commit credentials.

## 5. Smoke-test the channel server alone **[Claude + Pete]**

Before involving Claude Code, prove the channel server can connect to Zulip and receive messages.

I'll write a tiny `bun run scripts/zulip-ping.ts` that:
1. Loads `.env`
2. Calls Zulip's `/users/me` endpoint with the bot's creds
3. Prints either "OK, bot is `writer-bot`, user ID 12345" or a clear error

You run it. If it fails, fix creds before going further. (This catches typos and rejected keys before MCP / Claude Code is involved — way easier to debug.)

## 6. First end-to-end run **[Pete]**

```
cd ~/zulip-claude-channel
claude-sfc --dangerously-load-development-channels server:zulip-channel
```

(Use `claude-sfc`, not bare `claude` — your shell function points it at `~/.claude-sfc`, where the handoff/forget skills and SessionStart hook live. Bare `claude` defaults to `~/.claude`, which doesn't exist.)

Claude Code will:
1. Read `.mcp.json`, spawn `zulip-channel.ts` as a subprocess
2. The channel server validates Zulip creds (per spec), opens an event queue on the home stream, declares `claude/channel` capability
3. Claude Code wires the channel into your session and prints something like "channel `zulip-channel` registered"

In Zulip, post in the `writer` stream:

> hey, are you there?

Within a second or two, the bot should reply in the same stream with whatever Claude says.

## 7. Verify permission relay **[Pete]**

In Zulip, post:

> can you list the files in your working directory?

Claude will want to call `Bash`, which triggers a permission prompt. You should see:

- A message in Zulip from the bot: "wants to run **Bash**: ..." with `request_id` and pre-populated ✅/❌ reactions
- The local terminal also shows the dialog

Tap ✅ in Zulip. The terminal dialog closes; Claude runs the command; you get the file list back in Zulip.

Then try a danger-regex case (e.g., ask it to run `rm -rf` something nonexistent). The Zulip prompt should appear *without* pre-populated reactions; type `yes <id>` to approve.

**Optional visual polish — alert words.** Zulip can highlight messages containing specific strings. Set this up so permission prompts visually pop:

1. Open **Personal Settings** (avatar → Personal Settings).
2. Look for an **"Alert words"** tab in the sidebar — usually below "Topics" / "Muted users." Direct URL: `<your-realm>.zulipchat.com/#settings/alert-words`.
3. Add `🔒` and `⚠️` as alert words.

Messages from the bot containing those emojis will now render with a highlighted background. Skip this if your Zulip version doesn't expose the tab — the emojis still differentiate prompts visually without it.

## 8. Verify handoff/forget **[Pete]**

In Claude Code (the terminal session), run `/handoff`. A `HANDOFF.md` should appear in `~/zulip-claude-channel/`.

Quit Claude (`/exit` or Ctrl+C twice). Restart with the same command from step 6. The SessionStart hook should inject the HANDOFF.md content; Claude in Zulip should know what it was doing previously.

Then `/forget`, exit, restart. The handoff should now be archived under `.handoffs/` and not loaded.

## You know phase 1 works when

- Posting in `#writer` reaches Claude within ~1 second.
- Claude's reply lands in the same stream.
- Permission prompts appear in Zulip with tap-to-approve.
- Danger-regex prompts require typed `yes <id>`.
- Handoff persists across session restarts; forget archives it cleanly.

## If it breaks

- **Bot doesn't appear in Zulip / no reply:** check `~/.claude-sfc/debug/<session-id>.txt` (or wherever Claude Code logs MCP errors) for stderr from `zulip-channel.ts`. Most likely: bad credentials (re-run step 5 ping), or bot isn't subscribed to the stream (step 1.5).
- **Channel doesn't register:** Claude Code prints a startup notice. Most likely you forgot `--dangerously-load-development-channels` (custom channels need that flag during research preview).
- **Permission relay times out / hangs:** known phase-1 limitation (no auto-deny). React or hard-restart.

## What's next (not phase 1)

- **Phase 2** is built in four end-to-end testable slices (see SPEC.md for details):
  - **2.1** — dispatcher daemon that wakes one hardcoded bot.
  - **2.2** — `@dispatch` Zulip bot for lifecycle commands (`spin up`, `shut down`, `list active`, etc.).
  - **2.3** — `--resume` + `HANDOFF.md` for memory across sleep/wake; adds `compact` and `reset`.
  - **2.4** — multi-bot fleet, `create-bot` provisioning, per-bot variation.
- **Phase 3** — inter-bot summoning via @-mentions, fleet roster, loop hazard handling. See SPEC.md.
