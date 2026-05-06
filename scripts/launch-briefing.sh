#!/bin/bash
# Launch the briefing-bot's Claude session with the channel server attached.
# Until the phase 2.1 dispatcher takes over spawn lifecycle (step 4+), this is
# the manual equivalent: cd into the bot's working tree, load Zulip creds from
# the project .env so the channel MCP subprocess has them, set
# CLAUDE_CONFIG_DIR to -sfc, and pass the channel + shared-MCP-config flags.

set -e

BOT_DIR="$HOME/claude-fleet/briefing"
PROJECT_DIR="$HOME/zulip-claude-channel"

if [ ! -d "$BOT_DIR" ]; then
  echo "FAIL: $BOT_DIR not found" >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "FAIL: $PROJECT_DIR/.env not found" >&2
  exit 1
fi

# Bun auto-loads .env from the channel server's cwd, but the bot's working
# tree (cwd) is not the project repo. Source and export the project .env here
# so the env cascades through claude → bun zulip-channel.ts.
set -a
. "$PROJECT_DIR/.env"
set +a

cd "$BOT_DIR"
exec env CLAUDE_CONFIG_DIR="$HOME/.claude-sfc" \
  claude \
    --dangerously-load-development-channels server:zulip-channel \
    --mcp-config "$PROJECT_DIR/shared-mcp.json"
