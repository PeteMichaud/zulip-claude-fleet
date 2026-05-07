// Pure formatting helpers. Used by zulip-channel.ts for permission prompts
// and by dispatcher.ts for fleet-ops command replies.

/**
 * Render a tool's `input_preview` (a JSON string Claude Code provides,
 * truncated to ~200 chars) as Zulip-friendly key-value lines. Each value
 * goes in inline backticks so it wraps on whitespace; fenced code blocks
 * don't soft-wrap in Zulip and would horizontally truncate long inputs.
 *
 * Falls back to a single inline-code line when the input isn't parseable
 * JSON (e.g. truncated mid-string by Claude Code's 200-char cap).
 *
 * Backticks inside values are replaced with single quotes so they don't
 * break out of the inline-code formatting.
 */
export function formatPreview(s: string): string {
  try {
    const obj = JSON.parse(s);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return `\`${s.replace(/`/g, "'")}\``;
    }
    return Object.entries(obj)
      .map(([k, v]) => {
        const raw = typeof v === 'string' ? v : JSON.stringify(v);
        const safe = raw.replace(/`/g, "'");
        return `**${k}**: \`${safe}\``;
      })
      .join('\n');
  } catch {
    return `\`${s.replace(/`/g, "'")}\``;
  }
}

/** Compact human-readable duration: "5s", "3m12s", "2h7m". */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
