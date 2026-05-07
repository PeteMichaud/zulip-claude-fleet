// Split a long string into chunks that fit Zulip's per-message limit
// (~10k characters). Prefers breaking at newlines near the cap; otherwise
// hard-cuts. Caller is responsible for adding `(part i/N)` prefixes.

export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen; // no good break in upper half — hard-cut
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
