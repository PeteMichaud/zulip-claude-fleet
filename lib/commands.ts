// Parser for fleet-ops commands posted in #Dispatch. Pure (regex against
// trimmed text) so it's trivial to unit-test.

export type Command =
  | { kind: 'spinUp'; target: string }
  | { kind: 'shutDown'; target: string }
  | { kind: 'reset'; target: string }
  | { kind: 'listActive' }
  | { kind: 'status'; target: string | undefined }
  | { kind: 'logs'; target: string; n: number }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

const DEFAULT_LOG_LINES = 30;

export function parseCommand(text: string): Command {
  const t = text.trim();

  let m;
  if ((m = t.match(/^(?:spin\s+up|start)\s+@?(\w+)\s*$/i))) {
    return { kind: 'spinUp', target: m[1] };
  }
  if ((m = t.match(/^(?:shut\s+down|stop|kill)\s+@?(\w+)\s*$/i))) {
    return { kind: 'shutDown', target: m[1] };
  }
  if ((m = t.match(/^reset\s+@?(\w+)\s*$/i))) {
    return { kind: 'reset', target: m[1] };
  }
  if (/^list(\s+active)?\s*$/i.test(t)) {
    return { kind: 'listActive' };
  }
  if ((m = t.match(/^status(?:\s+@?(\w+))?\s*$/i))) {
    return { kind: 'status', target: m[1] };
  }
  if ((m = t.match(/^logs?\s+@?(\w+)(?:\s+(\d+))?\s*$/i))) {
    return { kind: 'logs', target: m[1], n: m[2] ? parseInt(m[2], 10) : DEFAULT_LOG_LINES };
  }
  if (/^help\s*$/i.test(t)) {
    return { kind: 'help' };
  }
  return { kind: 'unknown', text: t };
}
