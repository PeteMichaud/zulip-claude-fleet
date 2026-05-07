import { describe, expect, test } from 'bun:test';
import { formatPreview, humanDuration } from './format.ts';

describe('formatPreview', () => {
  test('simple JSON object renders as bold key + inline-code value', () => {
    const out = formatPreview('{"file_path":"/a/b","content":"hi"}');
    expect(out).toBe('**file_path**: `/a/b`\n**content**: `hi`');
  });

  test('non-string values are JSON-stringified', () => {
    const out = formatPreview('{"n":42,"flag":true,"nested":{"k":1}}');
    expect(out).toBe('**n**: `42`\n**flag**: `true`\n**nested**: `{"k":1}`');
  });

  test('backticks in values are sanitized to single quotes', () => {
    const out = formatPreview('{"cmd":"echo `hi`"}');
    expect(out).toBe("**cmd**: `echo 'hi'`");
  });

  test('truncated/unparseable JSON falls back to inline code', () => {
    const out = formatPreview('{"file_path":"/long/path","content":"…');
    expect(out).toBe('`{"file_path":"/long/path","content":"…`');
  });

  test('non-object JSON (string, number, array) falls back to inline code', () => {
    expect(formatPreview('"just a string"')).toBe('`"just a string"`');
    expect(formatPreview('42')).toBe('`42`');
    expect(formatPreview('[1,2,3]')).toBe('`[1,2,3]`');
    expect(formatPreview('null')).toBe('`null`');
  });

  test('empty object', () => {
    expect(formatPreview('{}')).toBe('');
  });
});

describe('humanDuration', () => {
  test('seconds only when < 60', () => {
    expect(humanDuration(0)).toBe('0s');
    expect(humanDuration(5_000)).toBe('5s');
    expect(humanDuration(59_999)).toBe('59s');
  });

  test('minutes + seconds when < 1h', () => {
    expect(humanDuration(60_000)).toBe('1m0s');
    expect(humanDuration(125_000)).toBe('2m5s');
    expect(humanDuration(3_599_000)).toBe('59m59s');
  });

  test('hours + minutes when >= 1h', () => {
    expect(humanDuration(3_600_000)).toBe('1h0m');
    expect(humanDuration(3_660_000)).toBe('1h1m');
    expect(humanDuration(7_320_000)).toBe('2h2m');
  });
});
