import { describe, expect, test } from 'bun:test';
import { chunkMessage } from './chunking.ts';

describe('chunkMessage', () => {
  test('short text returns as a single chunk', () => {
    expect(chunkMessage('hi', 100)).toEqual(['hi']);
    expect(chunkMessage('', 100)).toEqual(['']);
  });

  test('text exactly at maxLen is one chunk', () => {
    const s = 'x'.repeat(100);
    expect(chunkMessage(s, 100)).toEqual([s]);
  });

  test('breaks at newline near the cap', () => {
    const text = 'line1\nline2\nline3\nline4';
    const chunks = chunkMessage(text, 12);
    // First chunk should be "line1\nline2" (11 chars, fits in 12) — newline at idx 11.
    expect(chunks[0]).toBe('line1\nline2');
    // Subsequent chunks contain the rest, no leading newlines.
    expect(chunks.every((c) => !c.startsWith('\n'))).toBe(true);
    // Concatenating chunks (with newlines re-inserted) should reconstruct the original.
    expect(chunks.join('\n')).toBe(text);
  });

  test('hard-cuts when no newline is in the upper half of the window', () => {
    // No newlines at all: must hard-cut at maxLen.
    const text = 'x'.repeat(25);
    const chunks = chunkMessage(text, 10);
    expect(chunks).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  test('hard-cut still triggers when only newline is in lower half', () => {
    // Only newline is at index 2; maxLen=10 means upper half threshold is 5.
    // 2 < 5, so the implementation discards the early newline and hard-cuts at 10.
    const text = 'ab\ncdefghijklmnopqrst'; // 21 chars
    const chunks = chunkMessage(text, 10);
    expect(chunks[0]).toBe('ab\ncdefghi'); // first 10 chars (incl. the early newline)
    expect(chunks[0].length).toBe(10);
  });

  test('preserves total content (sans dropped intermediate newlines)', () => {
    const text = Array.from({ length: 50 }, (_, i) => `row${i}`).join('\n');
    const chunks = chunkMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n')).toBe(text);
  });
});
