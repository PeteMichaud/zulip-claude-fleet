// Permission relay helpers — pure logic only. The IO side (sending the
// prompt to Zulip, emitting the verdict back to Claude Code) lives in
// zulip-channel.ts.

/**
 * Patterns that bypass the tap-to-approve reaction path and require a
 * typed `yes <id>` verdict. Checked against `${tool_name} ${input_preview}`.
 *
 * Add or remove entries as friction-vs-safety tradeoffs become clear.
 */
export const DANGER_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+-rf\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /--force-with-lease\b/i,
  /\bcurl\b[^|]*\|\s*sh\b/i,
  /\bsudo\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
];

export function isDangerousToolCall(toolName: string, inputPreview: string): boolean {
  const haystack = `${toolName} ${inputPreview}`;
  return DANGER_PATTERNS.some((p) => p.test(haystack));
}

/**
 * Match `yes abcde` / `no abcde` (and short forms `y`/`n`).
 *
 * Claude Code generates request IDs as five lowercase letters drawn from
 * `a`-`z` minus `l` (so it can't be misread as `1` or `I` on a phone).
 * The /i flag here tolerates phone autocorrect that capitalizes the reply;
 * the caller should lowercase the captured ID before emitting the verdict.
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export type Verdict = { behavior: 'allow' | 'deny'; request_id: string };

/** Returns null if the text isn't a verdict. */
export function parseVerdictReply(text: string): Verdict | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  return {
    behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
    request_id: m[2].toLowerCase(),
  };
}
