// Shared types referenced by both dispatcher.ts and the lib/ modules it
// composes. Pulled out so lib/ files don't have to import from the
// dispatcher entry point (which would invert the dependency direction).

export type Subprocess = ReturnType<typeof Bun.spawn>;

// Inbound that triggered a bot wake. Persisted to .wake-trigger.json in the
// bot's cwd at spawn time and replayed by the channel server on startup.
export type WakeTrigger = {
  stream: string;
  topic: string;
  sender: string;
  content: string;
  inbound_message_id?: number;
};

// Per-bot registry record. `bot_email` / `bot_api_key` are the credentials
// the bot's *own* channel server runs under (injected at spawn), distinct
// from dispatch-bot's identity.
export type Bot = {
  name: string;
  home_stream: string;
  cwd: string;
  bot_email: string;
  bot_api_key: string;
  // Optional per-bot override. When unset, the bot inherits the dispatcher's
  // global default (CLAUDE_CONFIG_DIR env or ~/.claude). Lets a single fleet
  // mix bots running under different Claude config profiles.
  config_dir?: string;
  // auto: channel server auto-approves every non-danger permission prompt
  // (no Zulip prompt, no operator tap). Danger filter still applies.
  auto?: boolean;
  // yolo: passes `--dangerously-skip-permissions` to the spawned claude.
  // Bypasses ALL permission checks including danger patterns. Use with care.
  yolo?: boolean;
};
