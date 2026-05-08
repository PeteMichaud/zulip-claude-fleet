// Persistent auto-allowlist: when the operator taps ♾️ on a non-danger
// permission prompt, we append a rule to the bot's .claude/settings.local.json
// so the next session won't re-prompt for similar calls.
//
// Reload behavior: Claude Code snapshots permissions at session start (per
// our reading of the docs/CLI), so the rule takes effect on the next spawn,
// not the live session. The current call is approved separately via the
// usual verdict-emit path; this file just persists the rule for future runs.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PATH_TOOLS = new Set(['Write', 'Edit', 'Read', 'NotebookEdit']);

// Inputs come from Claude Code's permission_request notification. We try to
// derive the tightest reasonable allow rule given the tool and its args.
// Fallback for anything unrecognized: just the bare tool name (overly broad
// but safe — the operator can narrow it manually).
export function derivePattern(toolName: string, inputPreview: string): string {
  let args: unknown = null;
  try {
    args = JSON.parse(inputPreview);
  } catch {
    return toolName;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolName;
  const a = args as Record<string, unknown>;

  if (toolName === 'Bash') {
    const cmd = typeof a.command === 'string' ? a.command : '';
    const firstToken = cmd.trim().split(/\s+/)[0];
    if (firstToken) return `Bash(${firstToken}:*)`;
    return 'Bash';
  }

  if (PATH_TOOLS.has(toolName)) {
    const p = typeof a.file_path === 'string' ? a.file_path : null;
    if (p) return `${toolName}(${p})`;
    return toolName;
  }

  // mcp__server__tool already includes server + tool — granular enough.
  if (toolName.startsWith('mcp__')) return toolName;

  return toolName;
}

// Inverse of derivePattern: does an incoming permission request match an
// already-allowed pattern? Used by the channel server's runtime allowlist
// so a fresh ♾️ tap takes effect mid-session, not just on next spawn.
export function matchesAllow(toolName: string, inputPreview: string, pattern: string): boolean {
  // Bash(<token>:*) — match if the command's first token equals <token>.
  const bashMatch = /^Bash\(([^):]+):\*\)$/.exec(pattern);
  if (bashMatch && toolName === 'Bash') {
    const expected = bashMatch[1];
    try {
      const args = JSON.parse(inputPreview);
      const cmd = typeof args?.command === 'string' ? args.command : '';
      return cmd.trim().split(/\s+/)[0] === expected;
    } catch {
      return false;
    }
  }

  // <PathTool>(<path>) — exact file_path match.
  const pathMatch = /^(Write|Edit|Read|NotebookEdit)\((.+)\)$/.exec(pattern);
  if (pathMatch && toolName === pathMatch[1]) {
    try {
      const args = JSON.parse(inputPreview);
      return typeof args?.file_path === 'string' && args.file_path === pathMatch[2];
    } catch {
      return false;
    }
  }

  // Bare tool name (e.g. mcp__server__tool, or any unknown tool falling back
  // to its own name in derivePattern). Exact match.
  return pattern === toolName;
}

export type AllowlistAppendResult = { added: boolean; pattern: string; allow: string[] };

// Append `pattern` to settings.permissions.allow at filePath. No-op if the
// pattern is already present. Atomic write via tmp + rename. Throws if the
// file exists but isn't valid JSON — refusing to clobber an unparseable
// settings file is safer than silently rewriting it.
export function appendAllowEntry(filePath: string, pattern: string): AllowlistAppendResult {
  let settings: any = {};
  if (existsSync(filePath)) {
    try {
      settings = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (err: any) {
      throw new Error(`settings file ${filePath} exists but isn't valid JSON: ${err.message}`);
    }
  }
  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }
  const allow: string[] = settings.permissions.allow;
  if (allow.includes(pattern)) {
    return { added: false, pattern, allow: [...allow] };
  }
  allow.push(pattern);

  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, filePath);
  return { added: true, pattern, allow: [...allow] };
}
