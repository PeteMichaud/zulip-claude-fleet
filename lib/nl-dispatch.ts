// Natural-language fallback for the regex command parser. When parseCommand
// returns 'unknown', spawn `claude --print` with a system prompt enumerating
// the dispatcher's command schema and ask for a JSON ARRAY of commands. The
// array is validated element-by-element and mapped back to a plan the
// caller can execute in order.
//
// Multi-step inputs are first-class: "pin briefing and create folder X"
// returns two commands and the caller iterates. An empty array means "input
// doesn't map to any command" (chat). `null` means a transport/parse failure.
//
// Spawn and timeout are injected so tests can run the parser without invoking
// the real CLI.

import { parseTargetToken, type Command } from './commands.ts';

// nlDispatch never returns `unknown` — that's an input-side parse failure.
// Empty array means Claude said "no command"; null means we couldn't talk to it.
export type NLCommand = Exclude<Command, { kind: 'unknown' }>;

export type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
};

export type SpawnFn = (
  cmd: string[],
  input: string,
  timeoutMs: number,
) => Promise<SpawnResult>;

export type NLDispatchOptions = {
  spawn?: SpawnFn;
  timeoutMs?: number;
  configDir?: string;
  model?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You translate natural-language fleet-ops requests into a JSON ARRAY of structured commands for a Zulip-driven Claude Code fleet dispatcher.

Output exactly one JSON array on a single line. No prose, no markdown fences, no explanation. Each element is one command. For a multi-step request, output the commands in execution order — they fire one by one. For a single command, output a one-element array. If the input doesn't map to any command (chat, ambiguous, etc.), output [].

Allowed element shapes:
- {"kind":"spinUp","target":"<bot>"} — start a bot
- {"kind":"shutDown","target":"<bot>"} — stop a bot (resumes on next start)
- {"kind":"reset","target":"<bot>"} — kill and clear stored session
- {"kind":"create","target":"<bot>"} — provision a new bot; optional "configDir":"<path>", "noSpin":true, "auto":true, "yolo":true
- {"kind":"update","target":"<bot>"} — change a bot's settings; optional "configDir":"<path>", "clearConfig":true, "auto":true|false, "yolo":true|false
- {"kind":"retire","target":"<bot>"} — fully decommission
- {"kind":"listActive"} — list running bots
- {"kind":"status","target":"<bot>"} or {"kind":"status"} — bot or fleet status
- {"kind":"logs","target":"<bot>","n":<int>} — last n log lines (default 30)
- {"kind":"pin","target":"<stream>"} — pin a stream in the operator's sidebar
- {"kind":"unpin","target":"<stream>"}
- {"kind":"createFolder","name":"<name>"} — create a channel folder; optional "description":"<text>". Folder names are descriptive labels, preserve user case (e.g. "SFC", "Personal").
- {"kind":"listFolders"}
- {"kind":"setFolder","stream":"<s>","folder":"<f>"}
- {"kind":"clearFolder","stream":"<s>"}
- {"kind":"help"}

Rules:
- target/stream are single tokens: lowercase letters, digits, hyphens, underscores. Strip @, spaces, "the", "bot" suffix, etc.
- folder names are descriptive labels (preserve user case).
- If the user names a *new* bot, prefer create. If they reference an existing bot generically, infer the most appropriate verb.
- For multi-step requests with dependencies (e.g. "move X into a new folder F"), order matters: createFolder before setFolder.
- Don't invent extra fields. Don't add commentary.

Examples:
Input: spin up a python expert and call it pyrefactor
Output: [{"kind":"create","target":"pyrefactor"}]

Input: how's the briefing bot doing?
Output: [{"kind":"status","target":"briefing"}]

Input: pin #linear and pin #briefing
Output: [{"kind":"pin","target":"linear"},{"kind":"pin","target":"briefing"}]

Input: move briefing and linear into a new stream folder called SFC, and create a blank folder called Personal
Output: [{"kind":"createFolder","name":"SFC"},{"kind":"setFolder","stream":"briefing","folder":"SFC"},{"kind":"setFolder","stream":"linear","folder":"SFC"},{"kind":"createFolder","name":"Personal"}]

Input: thanks!
Output: []`;

export async function nlDispatch(
  text: string,
  opts: NLDispatchOptions = {},
): Promise<NLCommand[] | null> {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = opts.model ?? DEFAULT_MODEL;

  const args = [
    'claude',
    '--print',
    '--model', model,
    '--append-system-prompt', SYSTEM_PROMPT,
  ];

  let result: SpawnResult;
  try {
    result = await spawnFn(args, text, timeoutMs);
  } catch {
    return null;
  }
  if (result.timedOut || result.code !== 0) return null;

  return parseClaudeResponse(result.stdout);
}

// Exported for testing. Tolerant: strips fences and surrounding prose,
// extracts the JSON array, validates each element. Returns null on transport/
// parse failure, [] when Claude said "no command", or a list of commands.
export function parseClaudeResponse(stdout: string): NLCommand[] | null {
  const raw = extractJsonArray(stdout);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: NLCommand[] = [];
  for (const element of parsed) {
    const cmd = validateCommand(element);
    if (!cmd) return null; // any invalid element fails the whole plan
    out.push(cmd);
  }
  return out;
}

function extractJsonArray(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed) return null;

  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1].trim() : trimmed;

  // Find the last balanced [...] block. Reading right-to-left handles
  // "Here's the result: [...]" preambles cleanly.
  let depth = 0;
  let end = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    const ch = body[i];
    if (ch === ']') {
      if (depth === 0) end = i;
      depth++;
    } else if (ch === '[') {
      depth--;
      if (depth === 0 && end !== -1) {
        return body.slice(i, end + 1);
      }
    }
  }
  return null;
}

function validateCommand(parsed: unknown): NLCommand | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== 'string') return null;

  const target = typeof obj.target === 'string' ? parseTargetToken(obj.target) : undefined;

  switch (kind) {
    case 'spinUp':
    case 'shutDown':
    case 'reset':
    case 'retire':
    case 'pin':
    case 'unpin':
      if (!target) return null;
      return { kind, target };

    case 'create': {
      if (!target) return null;
      const out: NLCommand = { kind: 'create', target };
      if (typeof obj.configDir === 'string') out.configDir = obj.configDir;
      if (obj.noSpin === true) out.noSpin = true;
      if (obj.auto === true) out.auto = true;
      if (obj.yolo === true) out.yolo = true;
      return out;
    }

    case 'clone': {
      // The NL fallback may name source either as `source` or `target`
      // (the schema uses `target` everywhere else and the model leans on
      // that habit); accept both.
      const sourceRaw = typeof obj.source === 'string' ? obj.source
        : typeof obj.target === 'string' ? obj.target
        : undefined;
      const source = parseTargetToken(sourceRaw);
      if (!source) return null;
      const newName = typeof obj.newName === 'string' ? parseTargetToken(obj.newName) : undefined;
      const out: NLCommand = { kind: 'clone', source };
      if (newName) out.newName = newName;
      if (obj.noSpin === true) out.noSpin = true;
      return out;
    }

    case 'update': {
      if (!target) return null;
      const out: NLCommand = { kind: 'update', target };
      if (typeof obj.configDir === 'string') out.configDir = obj.configDir;
      if (obj.clearConfig === true) out.clearConfig = true;
      if (obj.auto === true || obj.auto === false) out.auto = obj.auto;
      if (obj.yolo === true || obj.yolo === false) out.yolo = obj.yolo;
      return out;
    }

    case 'listActive':
      return { kind: 'listActive' };

    case 'status':
      return { kind: 'status', target };

    case 'logs': {
      if (!target) return null;
      const n = typeof obj.n === 'number' && Number.isFinite(obj.n) && obj.n > 0
        ? Math.floor(obj.n)
        : 30;
      return { kind: 'logs', target, n };
    }

    case 'createFolder': {
      // Folder names are descriptive labels (e.g. "SFC", "Personal"), not
      // identifiers — keep the user's case. Just trim and reject empty.
      const raw = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (!raw) return null;
      const out: NLCommand = { kind: 'createFolder', name: raw };
      if (typeof obj.description === 'string') out.description = obj.description;
      return out;
    }

    case 'listFolders':
      return { kind: 'listFolders' };

    case 'setFolder': {
      const stream = typeof obj.stream === 'string' ? parseTargetToken(obj.stream) : undefined;
      const folder = typeof obj.folder === 'string' ? obj.folder : undefined;
      if (!stream || !folder) return null;
      return { kind: 'setFolder', stream, folder };
    }

    case 'clearFolder': {
      const stream = typeof obj.stream === 'string' ? parseTargetToken(obj.stream) : undefined;
      if (!stream) return null;
      return { kind: 'clearFolder', stream };
    }

    case 'help':
      return { kind: 'help' };

    case 'none':
    default:
      return null;
  }
}

// Real spawn used at runtime. Bun.spawn handles non-TTY cleanly here because
// `claude --print` is headless — no PTY needed unlike interactive sessions.
async function defaultSpawn(
  cmd: string[],
  input: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  const proc = Bun.spawn({
    cmd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  proc.stdin.write(input);
  await proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already dead */ }
  }, timeoutMs);

  const code = await proc.exited;
  clearTimeout(timer);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { stdout, stderr, code, timedOut };
}
