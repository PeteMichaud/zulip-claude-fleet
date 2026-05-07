# Testing

Run with `bun test` (or `bun run test`).

## What's covered

Pure-function unit tests under `lib/*.test.ts` (45 tests, ~25 ms). Every helper that lives in `lib/` has a test file beside it.

| Module | What's tested |
| --- | --- |
| `lib/commands.ts` | Every documented command (spin up, shut down, list active, status, logs, help), synonyms (`start`/`stop`/`kill`), optional `@` prefix, casing, multi-space, whitespace tolerance, unknown-input fallback. |
| `lib/format.ts` | `formatPreview` for valid/invalid JSON, backtick sanitization, non-object/array/null fallback, empty object. `humanDuration` across the seconds → minutes → hours boundaries. |
| `lib/chunking.ts` | Short/exact-fit/long inputs, newline-near-cap break, hard-cut when no good newline in upper half, content preservation across joins. |
| `lib/permission.ts` | `isDangerousToolCall` against the full pattern set (rm -rf, sudo, git push --force, curl \| sh, dd, mkfs, --force-with-lease) and clean negatives. `parseVerdictReply` for valid IDs, the `a-km-z` alphabet (no `l`), exact length, phone-autocorrect casing, whitespace, non-verdict text. |
| `lib/zulip.ts` | `makeZulipClient` builds URLs under `/api/v1`, sets Basic auth, encodes GET params, JSON-stringifies object/array params, form-encodes POST bodies, throws on non-success / non-2xx HTTP, passes `AbortSignal` through. Uses `globalThis.fetch` swap for hermetic mocking. |

## What's not covered

These are knowingly outside the unit-test layer because they require real-process or real-network behavior, and faking those well is more work than the coverage is worth right now. Each entry notes the path to test it later.

### Top-level scripts (`dispatcher.ts`, `zulip-channel.ts`, `scripts/zulip-ping.ts`)

These run side-effecting work at module load (auth check, queue registration, MCP connect). They're not importable in test contexts. Their internal *pure* logic is what's been extracted into `lib/` and tested there. The remaining un-tested surface is the **glue** — wiring helpers together with IO.

Specifically un-tested:

- **`handleMessage` routing** in dispatcher.ts. The split between `#Dispatch` → command parser, bot home stream → wake-up logic. Pure function `parseCommand` is tested; the routing decision itself is not.
- **`maybeSpawn` lock + isAlive logic.** Per-bot mutex, double-spawn prevention, exit-callback cleanup of the `runningBots` and `startTimes` maps.
- **`spawnBot`** — `Bun.spawn` invocation, env injection, wake-trigger file write, log pumping, exit handling. PTY layer (`pty-helper.py`) is not exercised.
- **Command implementations** (`cmdSpinUp`, `cmdShutDown`, `cmdListActive`, etc.) — they call into impure pieces (registry lookup, `maybeSpawn`, child kill, log file read).
- **Channel server's wake-trigger replay timing** — the `waitForReady` defer until the first `ListTools` call.
- **Channel server's permission relay outbound flow** — message post + reaction pre-population, the reaction → verdict mapping.
- **Zulip event loop** — `BAD_EVENT_QUEUE_ID` recovery, Abort-on-shutdown, idempotent shutdown.

### Path to test these

1. **Mock-Zulip integration** (next layer). Stand up a `Bun.serve` that mimics `/register`, `/events`, `/messages`, and reactions in-memory. Run dispatcher and channel server against it; assert behavior through observable outputs (HTTP calls into the mock, contents of the per-bot log file, contents of `state/<name>.json`). Mostly catches integration bugs in routing, queue lifecycle, and command handlers.

2. **Stub-`claude` E2E**. A shell script in PATH that pretends to be Claude Code: prints the consent dialog, accepts Enter on stdin, then runs `bun zulip-channel.ts` so the channel server actually starts. Lets the dispatcher's spawn-supervise-respawn path get exercised end-to-end without burning real Claude tokens. The PTY layer would still be live in this version.

3. **Real-Zulip smoke** gated by `ZULIP_INTEGRATION_TEST=1`. The existing `scripts/zulip-ping.ts` is partway there for the auth path; would extend to a few send/read round-trips. Slow and dependent on the realm — leave for CI when there's a CI to use.

## When to add what

- **Adding a new command** → add a case to `parseCommand` and a test in `commands.test.ts`. The handler can stay un-unit-tested for now.
- **Adding a danger pattern** → add to `DANGER_PATTERNS` and a positive test in `permission.test.ts`.
- **Changing the Zulip helper** → corresponding test in `zulip.test.ts`. The mock-fetch pattern there is straightforward to extend.
- **Anything else in dispatcher.ts / zulip-channel.ts** → no test until we add the mock-Zulip layer. Manual verification by running through the README quickstart for now.
