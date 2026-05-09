#!/usr/bin/env bun
// Stop hook for Zulip-fleet bots: block end-of-turn if Claude didn't call
// the channel server's `send` tool. Without this, Opus extended-thinking
// turns occasionally finish with a text-only response that stays in the
// local TTY / session JSONL and never reaches Zulip — the operator sees
// the bot go quiet despite an actual reply being written.
//
// The hook returns {"decision":"block","reason":...} so Claude gets one
// retry with the missed-send context. `stop_hook_active` is checked first
// to avoid infinite loops if Claude can't be coaxed into calling send on
// the second pass either.
//
// Configured by the dispatcher in each bot's .claude/settings.local.json
// at create + spawn time (see lib/bot-settings.ts).

import { readFileSync } from 'node:fs';

type Entry = {
  type?: 'user' | 'assistant' | 'system';
  message?: { role?: string; content?: unknown };
};

function isRealUserMessage(entry: Entry): boolean {
  if (entry.type !== 'user') return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return true;
  // Tool-result-only user entries are internal plumbing, not a fresh inbound.
  return content.some((c: any) => c?.type !== 'tool_result');
}

function isSendCall(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  // The MCP server is registered as "zulip-channel"; Claude exposes the tool
  // as "mcp__zulip-channel__send". Match the suffix to be resilient to
  // server-name renames during development.
  return name === 'send' || name.endsWith('__send');
}

const input = JSON.parse(await Bun.stdin.text()) as {
  transcript_path?: string;
  stop_hook_active?: boolean;
};

// First check: avoid infinite loops. If we've already blocked once this
// turn, accept the stop even if send is still missing.
if (input.stop_hook_active) process.exit(0);
if (!input.transcript_path) process.exit(0);

let entries: Entry[] = [];
try {
  const lines = readFileSync(input.transcript_path, 'utf-8').trim().split('\n');
  entries = lines
    .map((l) => { try { return JSON.parse(l) as Entry; } catch { return null; } })
    .filter((e): e is Entry => e !== null);
} catch {
  // Can't read transcript → don't block (fail open; the hook is best-effort).
  process.exit(0);
}

// Find the latest real user message (skipping tool_result-only entries).
let lastUserIdx = -1;
for (let i = entries.length - 1; i >= 0; i--) {
  if (isRealUserMessage(entries[i])) { lastUserIdx = i; break; }
}
if (lastUserIdx === -1) process.exit(0);

// Did any assistant entry after the last real user message call `send`?
let sent = false;
for (let i = lastUserIdx + 1; i < entries.length; i++) {
  const e = entries[i];
  if (e.type !== 'assistant') continue;
  const content = e.message?.content;
  if (!Array.isArray(content)) continue;
  if (content.some((c: any) => c?.type === 'tool_use' && isSendCall(c?.name))) {
    sent = true;
    break;
  }
}

if (sent) process.exit(0);

console.log(JSON.stringify({
  decision: 'block',
  reason:
    'You finished this turn without calling the `send` tool. ' +
    'Your reply is invisible to the operator unless you call `send`. ' +
    'Call it now with your final response — use the same stream and topic as the inbound channel event.',
}));
