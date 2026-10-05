import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";

/**
 * Snapshot the SQLite database to a private GitHub repo, and restore it on boot.
 * For hosts with an ephemeral disk (e.g. Render's free tier). Walrus holds the memories;
 * this keeps consent, attitudes, pending outbox rows and the turn log across restarts.
 * Disabled unless BACKUP_GITHUB_REPO and BACKUP_GITHUB_TOKEN are set.
 */
export class Backup {
  private lastHash = "";
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly path: string,
    private readonly dataDir: string,
    private readonly file = "blacksmith.db",
  ) {}

  static fromEnv(dataDir: string): Backup | undefined {
    const repo = process.env.BACKUP_GITHUB_REPO?.trim();
    const token = process.env.BACKUP_GITHUB_TOKEN?.trim();
    if (!repo || !token) return undefined;
    return new Backup(repo, token, process.env.BACKUP_GITHUB_PATH?.trim() || "blacksmith.db", dataDir);
  }

  /** Download the last snapshot if there is no local database yet. Call before opening the Db. */
  async restore(): Promise<void> {
    const dbPath = join(this.dataDir, this.file);
    if (existsSync(dbPath)) {
      console.log("[backup] local database exists; not restoring");
      return;
    }
    const res = await this.api("GET", { accept: "application/vnd.github.raw+json" });
    if (res.status === 404) {
      console.log("[backup] no snapshot yet; starting fresh");
      return;
    }
    if (!res.ok) throw new Error(`[backup] restore failed: ${res.status} ${await res.text()}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(dbPath, bytes);
    this.lastHash = sha256(bytes);
    console.log(`[backup] restored ${bytes.length} bytes from ${this.repo}/${this.path}`);
  }

  /** Upload a consistent snapshot if anything changed since the last upload. */
  async save(db: Db): Promise<void> {
    const tmp = join(this.dataDir, `snapshot-${Date.now()}.db`);
    try {
      db.sql.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const bytes = readFileSync(tmp);
      const hash = sha256(bytes);
      if (hash === this.lastHash) return;
      const meta = await this.api("GET");
      const sha = meta.ok ? ((await meta.json()) as { sha?: string }).sha : undefined;
      const res = await this.api("PUT", {
        body: JSON.stringify({ message: `backup ${new Date().toISOString()}`, content: bytes.toString("base64"), sha }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      this.lastHash = hash;
      console.log(`[backup] saved ${bytes.length} bytes`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  start(db: Db, everyMs = 5 * 60_000): void {
    this.timer = setInterval(() => this.save(db).catch((e) => console.error("[backup]", e)), everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private api(method: string, opts: { accept?: string; body?: string } = {}): Promise<Response> {
    return fetch(`https://api.github.com/repos/${this.repo}/contents/${this.path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: opts.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "blacksmith-backup",
      },
      body: opts.body,
    });
  }
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
