// Spawn orchestration for the dispatcher's bot lifecycle. Hosts the per-bot
// serialization lock and the contract "bump idle clock, then spawn" — the
// latter is load-bearing: if a long-asleep bot is respawned without first
// bumping last_active, the next idle sweep at t+60s sees the stale timestamp
// and SIGTERMs the freshly-spawned process before it can reply.
//
// Extracted so the ordering can be tested directly (lib/spawn-orchestrator.test.ts).

export type SpawnOrchestratorDeps<T extends { name: string }, Trigger> = {
  isAlive: (name: string) => boolean;
  bumpActivity: (name: string) => void;
  spawnBot: (bot: T, trigger: Trigger) => Promise<void>;
  log?: (...parts: unknown[]) => void;
};

export type SpawnOrchestrator<T extends { name: string }, Trigger> = {
  maybeSpawn(bot: T, trigger: Trigger): Promise<void>;
};

export function makeSpawnOrchestrator<T extends { name: string }, Trigger>(
  deps: SpawnOrchestratorDeps<T, Trigger>,
): SpawnOrchestrator<T, Trigger> {
  const log = deps.log ?? (() => {});
  const locks = new Map<string, Promise<unknown>>();

  return {
    async maybeSpawn(bot: T, trigger: Trigger): Promise<void> {
      // Serialize spawn attempts per bot. If a previous spawn is in flight,
      // wait for it; the second caller may then find the bot already alive.
      const previous = locks.get(bot.name);
      let releaseLock!: () => void;
      const lock = new Promise<void>((r) => { releaseLock = r; });
      locks.set(bot.name, previous ? previous.then(() => lock) : lock);
      if (previous) await previous;

      try {
        if (deps.isAlive(bot.name)) {
          log(`@${bot.name} already alive; not respawning (its own MCP will handle this inbound)`);
          return;
        }
        // Order matters: bump BEFORE spawn. See module header.
        deps.bumpActivity(bot.name);
        await deps.spawnBot(bot, trigger);
      } catch (err: any) {
        log(`@${bot.name} spawn failed: ${err.message}`);
      } finally {
        releaseLock();
      }
    },
  };
}
