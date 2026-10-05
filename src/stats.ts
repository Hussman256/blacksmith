import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCharacter } from "./characters.js";
import { config } from "./config.js";
import { Db, type TurnRow } from "./db.js";
import type { Memory } from "./memory.js";

/**
 * Evidence report for the write-up and the submission form: who played, on how many days,
 * how many memories each player has on Walrus, and the moments where a character recalled
 * something from an earlier session.
 */
const SESSION_GAP_MS = 6 * 3_600_000;
const db = new Db(config.dataDir);
const q = <T>(sql: string, ...args: (string | number)[]) => db.sql.prepare(sql).all(...args) as unknown as T[];

const names = new Map(q<{ user_id: string; name: string }>("SELECT user_id, name FROM players").map((p) => [p.user_id, p.name]));
const who = (id: string) => `${names.get(id) ?? "?"}`;

const memRows = q<{ user_id: string; done: number; pending: number; failed: number }>(`
  SELECT user_id,
    SUM(status = 'done') AS done, SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed
  FROM outbox GROUP BY user_id ORDER BY done DESC`);

const turnRows = q<{ user_id: string; on_turns: number; off_turns: number; days: number; first: number; last: number }>(`
  SELECT user_id,
    SUM(memory_on = 1) AS on_turns, SUM(memory_on = 0) AS off_turns,
    COUNT(DISTINCT date(ts / 1000, 'unixepoch')) AS days, MIN(ts) AS first, MAX(ts) AS last
  FROM turns GROUP BY user_id ORDER BY on_turns DESC`);

// When was each stored memory written? Prefer the relayer's created_at, fall back to our outbox.
const writtenAt = new Map<string, number>();
for (const r of q<{ blob_id: string | null; text: string; created_at: number }>("SELECT blob_id, text, created_at FROM outbox WHERE status = 'done'")) {
  if (r.blob_id) writtenAt.set(r.blob_id, r.created_at);
  writtenAt.set(r.text, r.created_at);
}

interface Moment {
  turn: TurnRow;
  old: { text: string; ageH: number }[];
}
const moments: Moment[] = [];
for (const t of q<TurnRow>("SELECT * FROM turns WHERE memory_on = 1 ORDER BY ts")) {
  const recalled = JSON.parse(t.recalled_json) as Memory[];
  const old = recalled
    .filter((m) => m.source === "walrus")
    .map((m) => {
      const at = (m.createdAt ? Date.parse(m.createdAt) : NaN) || writtenAt.get(m.blobId ?? "") || writtenAt.get(m.text);
      return { text: m.text, ageH: at ? (t.ts - at) / 3_600_000 : NaN };
    })
    .filter((m) => m.ageH * 3_600_000 >= SESSION_GAP_MS);
  if (old.length) moments.push({ turn: t, old });
}

const totals = db.outboxCounts();
const qualifying = memRows.filter((r) => r.done >= 10).length;
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const md = `# Blacksmith: evidence report
Generated ${new Date().toISOString()}

## Summary
- Players: ${names.size}
- Memories stored on Walrus: ${totals.done ?? 0} (pending ${totals.pending ?? 0}, failed ${totals.failed ?? 0})
- Players with at least 10 stored memories: **${qualifying}** (requirement: 3)
- Cross-session recall moments (a memory 6h+ old shaped a reply): ${moments.length}

## Memories per player
| Player | Stored | Pending | Failed |
|---|---|---|---|
${memRows.map((r) => `| ${who(r.user_id)} | ${r.done} | ${r.pending} | ${r.failed} |`).join("\n")}

## Activity per player
| Player | Turns (memory on) | Turns (memory off twin) | Active days | First | Last |
|---|---|---|---|---|---|
${turnRows.map((r) => `| ${who(r.user_id)} | ${r.on_turns} | ${r.off_turns} | ${r.days} | ${fmtDate(r.first)} | ${fmtDate(r.last)} |`).join("\n")}

## Cross-session recall moments
${
  moments.length
    ? moments
        .slice(-30)
        .map(
          ({ turn, old }) => `### ${fmtDate(turn.ts)}: ${who(turn.user_id)} → ${getCharacter(turn.npc).name}
Remembered:
${old.map((o) => `- "${o.text}" (written ${o.ageH < 48 ? `${Math.round(o.ageH)}h` : `${Math.round(o.ageH / 24)} days`} earlier)`).join("\n")}

> **${who(turn.user_id)}:** ${turn.message}
>
> **${getCharacter(turn.npc).name}:** ${turn.reply}
`,
        )
        .join("\n")
    : "_None yet. They appear once players come back after 6+ hours._"
}
`;

const out = join(config.dataDir, "evidence.md");
writeFileSync(out, md);
console.log(md.split("## Memories per player")[0]);
console.log(`Full report written to ${out}`);
