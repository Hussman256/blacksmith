import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface OutboxRow {
  id: number;
  namespace: string;
  text: string;
  kind: string;
  user_id: string;
  npc: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  next_attempt_at: number;
  blob_id: string | null;
  error: string | null;
  created_at: number;
  done_at: number | null;
}

export interface PlayerRow {
  user_id: string;
  name: string;
  joined_at: number;
  opted_out: number;
}

export interface TurnRow {
  id: number;
  ts: number;
  user_id: string;
  npc: string;
  memory_on: number;
  message: string;
  reply: string;
  recalled_json: string;
  facts_json: string;
  degraded: number;
}

/**
 * Local state. Walrus Memory is the source of truth for what characters remember;
 * this database only holds the write outbox, consent, a cache of attitudes,
 * and a turn log used as evidence for the write-up.
 */
export class Db {
  readonly sql: DatabaseSync;

  constructor(dir: string, file = "blacksmith.db") {
    if (dir !== ":memory:") mkdirSync(dir, { recursive: true });
    this.sql = new DatabaseSync(dir === ":memory:" ? ":memory:" : join(dir, file));
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS players (
        user_id TEXT PRIMARY KEY, name TEXT NOT NULL, joined_at INTEGER NOT NULL, opted_out INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attitudes (
        user_id TEXT NOT NULL, npc TEXT NOT NULL, value INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, npc)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL,
        user_id TEXT NOT NULL, npc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        blob_id TEXT, error TEXT, created_at INTEGER NOT NULL, done_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS outbox_ns ON outbox(namespace, status);
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        user_id TEXT NOT NULL, npc TEXT NOT NULL, memory_on INTEGER NOT NULL,
        message TEXT NOT NULL, reply TEXT NOT NULL,
        recalled_json TEXT NOT NULL DEFAULT '[]', facts_json TEXT NOT NULL DEFAULT '[]',
        degraded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS turns_user ON turns(user_id, npc, ts);
    `);
  }

  // --- players / consent ---
  getPlayer(userId: string): PlayerRow | undefined {
    return this.sql.prepare("SELECT * FROM players WHERE user_id = ?").get(userId) as PlayerRow | undefined;
  }
  join(userId: string, name: string): void {
    this.sql
      .prepare(
        `INSERT INTO players (user_id, name, joined_at, opted_out) VALUES (?, ?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, opted_out = 0`,
      )
      .run(userId, name, Date.now());
  }
  optOut(userId: string): void {
    this.sql.prepare("UPDATE players SET opted_out = 1 WHERE user_id = ?").run(userId);
    this.sql.prepare("UPDATE outbox SET status = 'failed', error = 'player opted out' WHERE user_id = ? AND status = 'pending'").run(userId);
  }
  isActive(userId: string): boolean {
    const p = this.getPlayer(userId);
    return !!p && !p.opted_out;
  }

  // --- attitudes (cache; the memory itself also records every change) ---
  getAttitude(userId: string, npc: string): number | undefined {
    const row = this.sql.prepare("SELECT value FROM attitudes WHERE user_id = ? AND npc = ?").get(userId, npc) as
      | { value: number }
      | undefined;
    return row?.value;
  }
  setAttitude(userId: string, npc: string, value: number): void {
    this.sql
      .prepare(
        `INSERT INTO attitudes (user_id, npc, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, npc) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(userId, npc, value, Date.now());
  }

  // --- outbox ---
  enqueue(row: { namespace: string; text: string; kind: string; userId: string; npc: string }): number {
    const r = this.sql
      .prepare(
        `INSERT INTO outbox (namespace, text, kind, user_id, npc, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(row.namespace, row.text, row.kind, row.userId, row.npc, Date.now());
    return Number(r.lastInsertRowid);
  }
  duePending(limit: number): OutboxRow[] {
    return this.sql
      .prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?")
      .all(Date.now(), limit) as unknown as OutboxRow[];
  }
  /** Facts written but maybe not yet searchable on the relayer (indexing lags a few seconds). */
  recentUnconfirmed(namespace: string, sinceMs: number): OutboxRow[] {
    return this.sql
      .prepare(
        `SELECT * FROM outbox WHERE namespace = ? AND created_at >= ?
         AND (status = 'pending' OR (status = 'done' AND done_at >= ?)) ORDER BY id`,
      )
      .all(namespace, sinceMs, Date.now() - 60_000) as unknown as OutboxRow[];
  }
  markDone(id: number, blobId: string): void {
    this.sql.prepare("UPDATE outbox SET status = 'done', blob_id = ?, done_at = ?, error = NULL WHERE id = ?").run(blobId, Date.now(), id);
  }
  markRetry(id: number, attempts: number, error: string, maxAttempts: number): void {
    const status = attempts >= maxAttempts ? "failed" : "pending";
    const backoff = Math.min(5 * 60_000, 2_000 * 2 ** attempts);
    this.sql
      .prepare("UPDATE outbox SET status = ?, attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?")
      .run(status, attempts, error.slice(0, 500), Date.now() + backoff, id);
  }
  outboxCounts(): Record<string, number> {
    const rows = this.sql.prepare("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status").all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  // --- turn log ---
  logTurn(t: Omit<TurnRow, "id">): void {
    this.sql
      .prepare(
        `INSERT INTO turns (ts, user_id, npc, memory_on, message, reply, recalled_json, facts_json, degraded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.ts, t.user_id, t.npc, t.memory_on, t.message, t.reply, t.recalled_json, t.facts_json, t.degraded);
  }
  /** Short-term conversation context: recent turns in the same sitting (not long-term memory). */
  recentTurns(userId: string, npc: string, memoryOn: boolean, withinMs: number, limit: number): TurnRow[] {
    const rows = this.sql
      .prepare(
        `SELECT * FROM turns WHERE user_id = ? AND npc = ? AND memory_on = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(userId, npc, memoryOn ? 1 : 0, Date.now() - withinMs, limit) as unknown as TurnRow[];
    return rows.reverse();
  }
}
