import { config } from "./config.js";
import { Db } from "./db.js";
import { Game } from "./game.js";
import { createLlm, type Llm } from "./llm.js";
import { createBackend, MemoryService, Outbox, type MemoryBackend } from "./memory.js";

export interface App {
  db: Db;
  backend: MemoryBackend;
  memory: MemoryService;
  outbox: Outbox;
  llm: Llm;
  game: Game;
  /** Stop the outbox timer and push whatever is still pending (bounded wait). */
  shutdown(timeoutMs?: number): Promise<void>;
}

/** Shared bootstrap for the Discord bot, the terminal REPL and the tests. Overrides are for tests. */
export function createApp(overrides: { db?: Db; backend?: MemoryBackend; llm?: Llm; startOutbox?: boolean } = {}): App {
  const db = overrides.db ?? new Db(config.dataDir);
  const backend = overrides.backend ?? createBackend();
  const memory = new MemoryService(backend, db);
  const outbox = new Outbox(backend, db);
  const llm = overrides.llm ?? createLlm();
  const game = new Game(db, memory, llm);
  if (overrides.startOutbox ?? true) outbox.start();

  return {
    db,
    backend,
    memory,
    outbox,
    llm,
    game,
    async shutdown(timeoutMs = 20_000) {
      outbox.stop();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && db.duePending(1).length) {
        await outbox.flush();
        if (db.duePending(1).length) await new Promise((r) => setTimeout(r, 500));
      }
      const left = db.outboxCounts().pending ?? 0;
      if (left) console.warn(`[app] ${left} memories still pending; they stay in the outbox and are sent on next start.`);
    },
  };
}
