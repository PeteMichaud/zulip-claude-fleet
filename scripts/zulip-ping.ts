#!/usr/bin/env bun
/**
 * Smoke test: validates that .env credentials work and the bot can reach Zulip.
 * Prints either a success line or a clear error and exits non-zero.
 */

const SITE = mustEnv('ZULIP_SITE');
const BOT_EMAIL = mustEnv('ZULIP_BOT_EMAIL');
const API_KEY = mustEnv('ZULIP_API_KEY');
const HOME_STREAM = mustEnv('ZULIP_HOME_STREAM');
const OWNER_USER_ID = parseInt(mustEnv('ZULIP_OWNER_USER_ID'), 10);

const auth = 'Basic ' + Buffer.from(`${BOT_EMAIL}:${API_KEY}`).toString('base64');

async function call(path: string, params?: Record<string, string>) {
  const url = new URL(`/api/v1${path}`, SITE);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: auth } });
  const data = await res.json() as any;
  if (!res.ok || data.result !== 'success') {
    throw new Error(`${path} failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

try {
  const me = await call('/users/me');
  console.log(`OK: authenticated as ${me.email} (user_id ${me.user_id}, name "${me.full_name}")`);

  // Check the home stream is reachable.
  const streams = await call('/streams');
  const home = streams.streams.find((s: any) => s.name === HOME_STREAM);
  if (!home) {
    console.error(`WARN: bot can't see stream "${HOME_STREAM}". Subscribe ${BOT_EMAIL} to it in Zulip's stream settings.`);
    process.exit(2);
  }
  console.log(`OK: home stream "${HOME_STREAM}" visible (id ${home.stream_id})`);
  console.log(`OK: owner user id ${OWNER_USER_ID} (gate sender against this)`);
  console.log(`Ready. Now run: claude-sfc --dangerously-load-development-channels server:zulip-channel`);
} catch (e: any) {
  console.error('FAIL:', e.message);
  process.exit(1);
}

function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`FAIL: missing env var ${key} (check .env)`);
    process.exit(1);
  }
  return v;
}
