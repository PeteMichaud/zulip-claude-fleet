// Parser for fleet-ops commands posted in #Dispatch. Pure (regex against
// trimmed text) so it's trivial to unit-test.

export type Command =
  | { kind: 'spinUp'; target: string }
  | { kind: 'shutDown'; target: string }
  | { kind: 'reset'; target: string }
  | { kind: 'createBot'; target: string }
  | { kind: 'retire'; target: string }
  | { kind: 'listActive' }
  | { kind: 'status'; target: string | undefined }
  | { kind: 'logs'; target: string; n: number }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

const DEFAULT_LOG_LINES = 30;

// Convert Zulip-formal @**Display Name** mentions to informal @name so
// the command regexes (which expect [\w-]+ targets) can match. Also drops
// the `-bot` suffix Zulip's autocomplete inserts (full_name is `<name>-bot`
// but the registry is keyed by `<name>`).
function normalizeMentions(text: string): string {
  return text.replace(
    /@\*\*([^*]+)\*\*/g,
    (_, raw) => '@' + String(raw).trim().toLowerCase().replace(/-bot$/, ''),
  );
}

export function parseCommand(text: string): Command {
  const t = normalizeMentions(text.trim());

  let m;
  if ((m = t.match(/^(?:spin[\s-]+up|wake[\s-]+up|wake|start)\s+@?([\w-]+)\s*$/i))) {
    return { kind: 'spinUp', target: m[1] };
  }
  if ((m = t.match(/^(?:shut[\s-]+down|stop|kill)\s+@?([\w-]+)\s*$/i))) {
    return { kind: 'shutDown', target: m[1] };
  }
  if ((m = t.match(/^reset\s+@?([\w-]+)\s*$/i))) {
    return { kind: 'reset', target: m[1] };
  }
  if ((m = t.match(/^create[\s-]?bot\s+@?([\w-]+)\s*$/i))) {
    return { kind: 'createBot', target: m[1] };
  }
  if ((m = t.match(/^retire\s+@?([\w-]+)\s*$/i))) {
    return { kind: 'retire', target: m[1] };
  }
  if (/^list([\s-]+active)?\s*$/i.test(t)) {
    return { kind: 'listActive' };
  }
  if ((m = t.match(/^status(?:\s+@?([\w-]+))?\s*$/i))) {
    return { kind: 'status', target: m[1] };
  }
  if ((m = t.match(/^logs?\s+@?([\w-]+)(?:\s+(\d+))?\s*$/i))) {
    return { kind: 'logs', target: m[1], n: m[2] ? parseInt(m[2], 10) : DEFAULT_LOG_LINES };
  }
  if (/^help\s*$/i.test(t)) {
    return { kind: 'help' };
  }
  return { kind: 'unknown', text: t };
}
