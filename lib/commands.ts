// Parser for fleet-ops commands posted in #Dispatch. Tokenizes the input,
// matches a (possibly multi-word) command head, then parses positionals and
// `--flag value` pairs from the rest. Pure so it's trivial to unit-test.

export type Command =
  | { kind: 'spinUp'; target: string }
  | { kind: 'shutDown'; target: string }
  | { kind: 'reset'; target: string }
  | { kind: 'create'; target: string; configDir?: string; noSpin?: boolean }
  | { kind: 'update'; target: string; configDir?: string; clearConfig?: boolean }
  | { kind: 'retire'; target: string }
  | { kind: 'listActive' }
  | { kind: 'status'; target: string | undefined }
  | { kind: 'logs'; target: string; n: number }
  | { kind: 'pin'; target: string }
  | { kind: 'unpin'; target: string }
  | { kind: 'createFolder'; name: string; description?: string }
  | { kind: 'listFolders' }
  | { kind: 'setFolder'; stream: string; folder: string }
  | { kind: 'clearFolder'; stream: string }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

const DEFAULT_LOG_LINES = 30;

// Convert Zulip-formal @**Display Name** mentions to informal @name so the
// target regex matches. Drops the `-bot` suffix Zulip's autocomplete inserts
// (full_name is `<name>-bot` but the registry is keyed by `<name>`).
function normalizeMentions(text: string): string {
  return text.replace(
    /@\*\*([^*]+)\*\*/g,
    (_, raw) => '@' + String(raw).trim().toLowerCase().replace(/-bot$/, ''),
  );
}

type HeadKind = Exclude<Command['kind'], 'unknown'>;

// Each entry is one alias for a command head. `phrase` is matched
// case-insensitively against the start of the input, with a whole-word
// boundary (end of string or whitespace). Multi-word phrases come first so
// `spin up` is tried before `spin`.
const HEADS: Array<{ phrase: string; kind: HeadKind }> = [
  // 2-word heads + their hyphen-glued 1-token variants.
  { phrase: 'spin up', kind: 'spinUp' },
  { phrase: 'spin-up', kind: 'spinUp' },
  { phrase: 'wake up', kind: 'spinUp' },
  { phrase: 'wake-up', kind: 'spinUp' },
  { phrase: 'shut down', kind: 'shutDown' },
  { phrase: 'shut-down', kind: 'shutDown' },
  { phrase: 'list active', kind: 'listActive' },
  { phrase: 'list-active', kind: 'listActive' },
  { phrase: 'create bot', kind: 'create' },
  { phrase: 'create-bot', kind: 'create' },
  { phrase: 'createbot', kind: 'create' },
  { phrase: 'create folder', kind: 'createFolder' },
  { phrase: 'create-folder', kind: 'createFolder' },
  { phrase: 'createfolder', kind: 'createFolder' },
  { phrase: 'list folders', kind: 'listFolders' },
  { phrase: 'list-folders', kind: 'listFolders' },
  { phrase: 'set folder', kind: 'setFolder' },
  { phrase: 'set-folder', kind: 'setFolder' },
  { phrase: 'clear folder', kind: 'clearFolder' },
  { phrase: 'clear-folder', kind: 'clearFolder' },
  // 1-word heads.
  { phrase: 'wake', kind: 'spinUp' },
  { phrase: 'start', kind: 'spinUp' },
  { phrase: 'stop', kind: 'shutDown' },
  { phrase: 'kill', kind: 'shutDown' },
  { phrase: 'reset', kind: 'reset' },
  { phrase: 'create', kind: 'create' },
  { phrase: 'update', kind: 'update' },
  { phrase: 'retire', kind: 'retire' },
  { phrase: 'list', kind: 'listActive' },
  { phrase: 'status', kind: 'status' },
  { phrase: 'logs', kind: 'logs' },
  { phrase: 'log', kind: 'logs' },
  { phrase: 'pin', kind: 'pin' },
  { phrase: 'unpin', kind: 'unpin' },
  { phrase: 'help', kind: 'help' },
];

// Aliases surfaced in the help text. Keep in sync with HEADS — manually,
// since we want a friendly canonical form per kind rather than dumping every
// variant Zulip-mentions, hyphenated, etc. produce.
export const ALIASES: Partial<Record<HeadKind, string[]>> = {
  spinUp: ['wake', 'wake up', 'start'],
  shutDown: ['stop', 'kill'],
  create: ['create-bot'],
  listActive: ['list'],
  logs: ['log'],
  createFolder: ['create-folder'],
  listFolders: ['list-folders'],
  setFolder: ['set-folder'],
  clearFolder: ['clear-folder'],
};

function matchHead(text: string): { kind: HeadKind; rest: string } | null {
  const lower = text.toLowerCase();
  for (const h of HEADS) {
    const p = h.phrase.toLowerCase();
    if (lower === p) return { kind: h.kind, rest: '' };
    if (lower.startsWith(p) && /\s/.test(lower[p.length] ?? '')) {
      return { kind: h.kind, rest: text.slice(h.phrase.length).trim() };
    }
  }
  return null;
}

type ParsedRest = {
  positionals: string[];
  flags: Map<string, string | true>;
};

// argv-style: `--key value` consumes two tokens, `--key=value` one,
// `--key` alone is boolean true (followed by another --flag or end-of-input).
function parseRest(rest: string): ParsedRest {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > -1) {
        flags.set(t.slice(2, eq), t.slice(eq + 1));
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        flags.set(t.slice(2), tokens[i + 1]);
        i++;
      } else {
        flags.set(t.slice(2), true);
      }
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
}

function asTarget(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^@?([\w-]+)$/);
  return m ? m[1] : undefined;
}

export function parseCommand(text: string): Command {
  // Collapse internal whitespace so 'shut  down briefing' parses the same
  // as 'shut down briefing'. Multi-word heads expect single-space form.
  const trimmed = normalizeMentions(text.trim()).replace(/\s+/g, ' ');
  if (!trimmed) return { kind: 'unknown', text: '' };

  const head = matchHead(trimmed);
  if (!head) return { kind: 'unknown', text: trimmed };

  const { positionals, flags } = parseRest(head.rest);
  const target = asTarget(positionals[0]);

  switch (head.kind) {
    case 'spinUp':
    case 'shutDown':
    case 'reset':
    case 'retire':
      if (!target) return { kind: 'unknown', text: trimmed };
      return { kind: head.kind, target };

    case 'create': {
      if (!target) return { kind: 'unknown', text: trimmed };
      const configFlag = flags.get('config');
      const configDir = typeof configFlag === 'string' ? configFlag : undefined;
      const noSpin = flags.get('no-spin') === true;
      const out: Command = { kind: 'create', target };
      if (configDir) out.configDir = configDir;
      if (noSpin) out.noSpin = true;
      return out;
    }

    case 'update': {
      if (!target) return { kind: 'unknown', text: trimmed };
      const configFlag = flags.get('config');
      const clearConfig = flags.get('clear-config') === true;
      const configDir = typeof configFlag === 'string' ? configFlag : undefined;
      const out: Command = { kind: 'update', target };
      if (configDir) out.configDir = configDir;
      if (clearConfig) out.clearConfig = true;
      return out;
    }

    case 'listActive':
      return { kind: 'listActive' };

    case 'status':
      return { kind: 'status', target };

    case 'logs': {
      if (!target) return { kind: 'unknown', text: trimmed };
      const nArg = positionals[1];
      const n = nArg && /^\d+$/.test(nArg) ? parseInt(nArg, 10) : DEFAULT_LOG_LINES;
      return { kind: 'logs', target, n };
    }

    case 'pin':
    case 'unpin': {
      if (!target) return { kind: 'unknown', text: trimmed };
      return { kind: head.kind, target };
    }

    case 'createFolder': {
      const name = positionals[0];
      if (!name) return { kind: 'unknown', text: trimmed };
      const descFlag = flags.get('description');
      const out: Command = { kind: 'createFolder', name };
      if (typeof descFlag === 'string') out.description = descFlag;
      return out;
    }

    case 'listFolders':
      return { kind: 'listFolders' };

    case 'setFolder': {
      const stream = asTarget(positionals[0]);
      const folder = positionals[1];
      if (!stream || !folder) return { kind: 'unknown', text: trimmed };
      return { kind: 'setFolder', stream, folder };
    }

    case 'clearFolder': {
      const stream = asTarget(positionals[0]);
      if (!stream) return { kind: 'unknown', text: trimmed };
      return { kind: 'clearFolder', stream };
    }

    case 'help':
      return { kind: 'help' };
  }
}
