import { createHash } from "node:crypto";
import { MemWal, MemWalMock } from "@mysten-incubation/memwal";
import type { RecallMemory } from "@mysten-incubation/memwal";
import { config, requireEnv } from "./config.js";
import type { Db, OutboxRow } from "./db.js";

/** The subset of the Walrus Memory client the game uses (real client and MemWalMock both satisfy it). */
export type MemoryBackend = Pick<MemWal, "recall" | "rememberAndWait" | "health">;

export function createBackend(): MemoryBackend {
  if (config.memwal.mode === "mock") {
    console.warn("[memory] MEMWAL_MODE=mock: using in-memory MemWalMock, nothing is written to Walrus");
    return MemWalMock.create();
  }
  return MemWal.create({
    key: requireEnv("MEMWAL_PRIVATE_KEY"),
    accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
    serverUrl: config.memwal.serverUrl,
  });
}

/**
 * Namespace layout. One delegate key can read every namespace under the account,
 * so isolation is enforced here: a player's private namespace is derived only from
 * their Discord user ID (authenticated by Discord), never from message content.
 */
export const ns = {
  private: (npcId: string, userId: string) => `${config.memwal.nsPrefix}:npc:${npcId}:player:${userId}`,
  world: () => `${config.memwal.nsPrefix}:world`,
};

export interface Memory {
  text: string;
  scope: "private" | "world";
  blobId?: string;
  distance?: number;
  createdAt?: string;
  /** "pending" = written this sitting but maybe not indexed yet. */
  source: "walrus" | "pending";
}

const ATTITUDE_RE = /attitude toward .+? is now (-?\d+)/i;

export class MemoryService {
  degraded = false;

  constructor(
    private readonly backend: MemoryBackend,
    private readonly db: Db,
    private readonly maxDistance = config.memwal.maxDistance,
  ) {}

  private async safeRecall(
    query: string,
    namespace: string,
    scope: Memory["scope"],
    opts: { limit: number; sort?: "relevance" | "recent"; maxDistance?: number | null },
  ): Promise<Memory[]> {
    try {
      const res = await this.backend.recall({
        query,
        namespace,
        limit: opts.limit,
        sort: opts.sort,
        maxDistance: opts.maxDistance === null ? undefined : (opts.maxDistance ?? this.maxDistance),
      });
      return res.results.map((m: RecallMemory) => ({
        text: m.text,
        scope,
        blobId: m.blob_id,
        distance: m.distance,
        createdAt: m.created_at,
        source: "walrus" as const,
      }));
    } catch (err) {
      this.degraded = true;
      console.error(`[memory] recall failed in ${namespace}:`, (err as Error).message);
      return [];
    }
  }

  private pending(namespace: string, scope: Memory["scope"]): Memory[] {
    return this.db
      .recentUnconfirmed(namespace, Date.now() - 2 * 60 * 60_000)
      .map((r: OutboxRow) => ({ text: r.text, scope, blobId: r.blob_id ?? undefined, source: "pending" as const }));
  }

  /**
   * Everything a character should have in mind before replying:
   * - what's relevant to the player's message (semantic recall),
   * - a fixed "who is this person to me" recall, so even "hi, I'm back" surfaces debts, promises and grudges,
   * - town rumours relevant to the message,
   * - facts written moments ago that the relayer may not have indexed yet.
   */
  async recallForTurn(npcId: string, userId: string, playerName: string, message: string): Promise<Memory[]> {
    this.degraded = false;
    const priv = ns.private(npcId, userId);
    const world = ns.world();
    const [relevant, core, rumours] = await Promise.all([
      this.safeRecall(message, priv, "private", { limit: 6 }),
      this.safeRecall(
        `Who is ${playerName} to me: their name, trade, what they did to me, debts, promises, insults, favours, and how I feel about them`,
        priv,
        "private",
        { limit: 6, sort: "recent", maxDistance: null },
      ),
      this.safeRecall(`${playerName}: ${message}`, world, "world", { limit: 4 }),
    ]);
    const seen = new Set<string>();
    const out: Memory[] = [];
    for (const m of [...relevant, ...core, ...this.pending(priv, "private"), ...rumours, ...this.pending(world, "world")]) {
      const key = m.blobId ?? m.text;
      if (seen.has(key) || seen.has(m.text)) continue;
      seen.add(key);
      seen.add(m.text);
      out.push(m);
    }
    return out;
  }

  /** Recover attitude from Walrus when the local cache is empty (fresh deploy, new machine). */
  async recallAttitude(npcId: string, userId: string, playerName: string): Promise<number | undefined> {
    const hits = await this.safeRecall(`attitude toward ${playerName} is now`, ns.private(npcId, userId), "private", {
      limit: 5,
      sort: "recent",
      maxDistance: null,
    });
    for (const h of hits) {
      const m = h.text.match(ATTITUDE_RE);
      if (m) return Number(m[1]);
    }
    return undefined;
  }

  async journal(npcId: string, userId: string, playerName: string, limit = 15): Promise<Memory[]> {
    return this.safeRecall(`Everything I remember about ${playerName}`, ns.private(npcId, userId), "private", {
      limit,
      maxDistance: null,
    });
  }

  async rumours(limit = 8): Promise<Memory[]> {
    return this.safeRecall("The latest news and rumours around town", ns.world(), "world", {
      limit,
      sort: "recent",
      maxDistance: null,
    });
  }
}

/**
 * Write-ahead outbox: every fact is committed to SQLite first, then pushed to Walrus Memory
 * with retries. A relayer hiccup delays a memory; it never silently loses one.
 */
export class Outbox {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly backend: MemoryBackend,
    private readonly db: Db,
    private readonly opts = { concurrency: 2, maxAttempts: 10, intervalMs: 2_000 },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async flush(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      const rows = this.db.duePending(this.opts.concurrency);
      await Promise.all(
        rows.map(async (row) => {
          try {
            const res = await this.backend.rememberAndWait(row.text, row.namespace, {
              timeoutMs: 60_000,
              idempotencyKey: idempotencyKey(row),
            });
            this.db.markDone(row.id, res.blob_id);
            done++;
            console.log(`[outbox] stored #${row.id} -> blob ${res.blob_id}`);
          } catch (err) {
            const msg = (err as Error).message ?? String(err);
            this.db.markRetry(row.id, row.attempts + 1, msg, this.opts.maxAttempts);
            console.warn(`[outbox] #${row.id} attempt ${row.attempts + 1} failed: ${msg}`);
          }
        }),
      );
    } finally {
      this.running = false;
    }
    return done;
  }
}

/** Stable per outbox row, so a retry after a timeout resolves to the same job instead of a duplicate blob. */
function idempotencyKey(row: OutboxRow): string {
  return createHash("sha256").update(`${row.id}\n${row.namespace}\n${row.text}`).digest("hex").slice(0, 32);
}
