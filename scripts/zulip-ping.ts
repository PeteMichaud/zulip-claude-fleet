#!/usr/bin/env bun
/**
 * Smoke test: validates that .env credentials work and the bot can reach Zulip.
 * Prints either a success line or a clear error and exits non-zero.
 *
 * Pings whichever bot's creds are in ZULIP_BOT_EMAIL/ZULIP_API_KEY (briefing
 * by default for now). Could be parameterized later to check dispatch-bot too.
 */

import { makeZulipClient } from '../lib/zulip.ts';

const SITE = mustEnv('ZULIP_SITE');
const BOT_EMAIL = mustEnv('ZULIP_BOT_EMAIL');
const API_KEY = mustEnv('ZULIP_API_KEY');
const HOME_STREAM = mustEnv('ZULIP_HOME_STREAM');
const OWNER_USER_ID = parseInt(mustEnv('ZULIP_OWNER_USER_ID'), 10);

const zulip = makeZulipClient({ site: SITE, email: BOT_EMAIL, apiKey: API_KEY });

try {
  const me = await zulip('/users/me');
  console.log(`OK: authenticated as ${me.email} (user_id ${me.user_id}, name "${me.full_name}")`);

  const streams = await zulip('/streams');
  const home = streams.streams.find((s: any) => s.name === HOME_STREAM);
  if (!home) {
    console.error(`WARN: bot can't see stream "${HOME_STREAM}". Subscribe ${BOT_EMAIL} to it in Zulip's stream settings.`);
    process.exit(2);
  }
  console.log(`OK: home stream "${HOME_STREAM}" visible (id ${home.stream_id})`);
  console.log(`OK: owner user id ${OWNER_USER_ID} (gate sender against this)`);
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
