import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createApp } from "./app.js";
import { attitudeLabel, CHARACTERS, getCharacter, TOWN } from "./characters.js";
import type { Player } from "./game.js";

/**
 * Play in the terminal, no Discord needed. Same game, same memory.
 * The player ID is derived from the name you type, so typing the same name later brings your memories back.
 */
const app = createApp();
const rl = createInterface({ input: stdin, output: stdout });

const nameArg = process.argv.find((a) => a.startsWith("--name="))?.slice(7);
const name = (nameArg ?? (await rl.question(`Welcome to ${TOWN}. What's your name, traveller? `))).trim() || "Stranger";
const player: Player = { id: `cli:${name.toLowerCase()}`, name };
app.db.join(player.id, name);

let npcId = "brannoc";
let memoryOn = true;

console.log(`
Commands: /npc ${Object.keys(CHARACTERS).join("|")}   /memory on|off   /journal   /rumours   /quit
You're at the forge. ${describe()}
`);

for (;;) {
  const line = (await rl.question(`${name} > `)).trim();
  if (!line) continue;
  if (line.startsWith("/")) {
    const [cmd, arg] = line.slice(1).split(/\s+/);
    if (cmd === "quit" || cmd === "exit") break;
    if (cmd === "npc" && arg && CHARACTERS[arg]) {
      npcId = arg;
      console.log(describe());
    } else if (cmd === "memory" && (arg === "on" || arg === "off")) {
      memoryOn = arg === "on";
      console.log(`Memory ${arg}. ${describe()}`);
    } else if (cmd === "journal") {
      const mems = await app.memory.journal(npcId, player.id, name);
      console.log(mems.length ? mems.map((m) => `  - ${m.text}${m.blobId ? `  [${m.blobId}]` : ""}`).join("\n") : "  (nothing yet)");
    } else if (cmd === "rumours") {
      const r = await app.memory.rumours();
      console.log(r.length ? r.map((m) => `  - ${m.text}`).join("\n") : "  (no rumours yet)");
    } else {
      console.log("Unknown command.");
    }
    continue;
  }

  try {
    const r = await app.game.turn({ player, npcId, message: line, memory: memoryOn });
    const npc = getCharacter(npcId);
    console.log(`\n${npc.emoji} ${npc.name}: ${r.reply}`);
    const info = memoryOn
      ? [
          `remembered ${r.recalled.length}`,
          r.facts.length ? `new: ${r.facts.map((f) => `"${f.text}"${f.scope === "world" ? " (rumour)" : ""}`).join("; ")}` : "",
          r.attitudeAfter !== r.attitudeBefore ? `attitude ${r.attitudeBefore} -> ${r.attitudeAfter} (${attitudeLabel(r.attitudeAfter)})` : "",
          r.dropped.length ? `skipped ${r.dropped.length} sensitive` : "",
          r.degraded ? "memory degraded" : "",
        ]
      : ["memory off"];
    console.log(`   · ${info.filter(Boolean).join(" · ")}\n`);
    void app.outbox.flush();
  } catch (err) {
    console.error("Turn failed:", (err as Error).message);
  }
}

rl.close();
console.log("Saving what the town remembers…");
await app.shutdown(60_000);
process.exit(0);

function describe(): string {
  const npc = getCharacter(npcId);
  return `Talking to ${npc.emoji} ${npc.name}, ${npc.title}. Memory ${memoryOn ? "ON" : "OFF"}.`;
}
