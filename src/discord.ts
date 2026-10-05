import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { createApp } from "./app.js";
import { Backup } from "./backup.js";
import { startHealthServer } from "./health.js";
import { attitudeLabel, CHARACTERS, getCharacter, TOWN } from "./characters.js";
import { config, requireEnv, walruscanBlobUrl, type ChannelBinding } from "./config.js";
import type { LearnResult, Player, TurnInput, TurnResult } from "./game.js";
import type { Memory } from "./memory.js";

const COOLDOWN_MS = 4_000;
const DISCORD_LIMIT = 2_000;

const CONSENT = `**Welcome to ${TOWN}.** The people here remember you between visits, across days and devices, using Walrus Memory.
After each conversation, a few short in-game facts (what you did, said, owe or promised) are stored encrypted on Walrus.
Stored memories can be hidden but not fully erased, so **don't share real personal information**: play a character.
Type \`/join name:<your character name>\` to start. \`/optout\` stops it at any time.`;

const HELP = `**Blacksmith: a town that remembers you**
Talk to the people of ${TOWN} by posting in their channels:
${[...config.discord.channels.entries()]
  .map(([ch, b]) => `- #${ch}: ${getCharacter(b.npcId).emoji} ${getCharacter(b.npcId).name}${b.memory ? "" : " (memory **off**, for comparison)"}`)
  .join("\n")}
They remember what you tell them and how you treat them. Be rude to Brannoc and his prices go up; earn his trust and they come down.
Rumours spread: do something in public and the whole town may hear about it.
Commands: \`/join\`, \`/talk\`, \`/journal\` (what they remember about you), \`/rumours\`, \`/optout\`.`;

const backup = Backup.fromEnv(config.dataDir);
await backup?.restore();
const app = createApp();
const { db, game, memory } = app;
backup?.start(db);

const busy = new Set<string>();
const lastTurn = new Map<string, number>();
const lastConsentNotice = new Map<string, number>();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
startHealthServer(db, () => client.isReady());

client.once(Events.ClientReady, (c) => {
  console.log(`[discord] logged in as ${c.user.tag}; watching channels: ${[...config.discord.channels.keys()].join(", ")}`);
});

// ---------- plain messages in a character's channel ----------
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.inGuild()) return;
  const binding = bindingFor(msg.channel);
  if (!binding) return;
  const text = msg.cleanContent.trim();
  if (!text) return;

  const player = activePlayer(msg.author.id);
  if (!player) {
    const last = lastConsentNotice.get(msg.author.id) ?? 0;
    if (Date.now() - last > 10 * 60_000) {
      lastConsentNotice.set(msg.author.id, Date.now());
      await msg.reply({ content: CONSENT, allowedMentions: { repliedUser: true } }).catch(logError);
    }
    return;
  }

  const wait = lockOrCooldown(player.id);
  if (wait) {
    await msg.react("⏳").catch(() => {});
    return;
  }
  try {
    if ("sendTyping" in msg.channel) await msg.channel.sendTyping().catch(() => {});
    await playTurn(
      { player, npcId: binding.npcId, message: text, memory: binding.memory },
      (content) => msg.reply({ content, allowedMentions: { repliedUser: false } }),
    );
  } catch (err) {
    logError(err);
    await msg.reply(`*${getCharacter(binding.npcId).name} seems distracted and doesn't answer. (Something went wrong, try again in a moment.)*`).catch(() => {});
  } finally {
    release(player.id);
  }
});

// ---------- slash commands ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case "join":
        return await onJoin(interaction);
      case "talk":
        return await onTalk(interaction);
      case "journal":
        return await onJournal(interaction);
      case "rumours":
        return await onRumours(interaction);
      case "optout":
        return await onOptOut(interaction);
      case "help":
        return await interaction.reply({ content: HELP, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    logError(err);
    const content = "Something went wrong. Try again in a moment.";
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

async function onJoin(i: ChatInputCommandInteraction) {
  const name = i.options.getString("name", true).replace(/[`*_~|<>@#]/g, "").replace(/\s+/g, " ").trim();
  if (name.length < 2) return i.reply({ content: "Pick a name with at least two letters.", flags: MessageFlags.Ephemeral });
  const returning = db.getPlayer(i.user.id);
  db.join(i.user.id, name);
  const where = [...config.discord.channels.entries()]
    .filter(([, b]) => b.memory)
    .map(([ch, b]) => `#${ch} (${getCharacter(b.npcId).name})`)
    .join(", ");
  const content = returning
    ? `Welcome back to ${TOWN}, **${name}**. The town remembers you.`
    : `${CONSENT.split("\n").slice(0, 3).join("\n")}\n\nYou're in, **${name}**. Head to ${where} and say hello.`;
  return i.reply({ content, flags: MessageFlags.Ephemeral });
}

async function onTalk(i: ChatInputCommandInteraction) {
  const player = activePlayer(i.user.id);
  if (!player) return i.reply({ content: CONSENT, flags: MessageFlags.Ephemeral });
  const chosen = i.options.getString("character");
  const binding: ChannelBinding | undefined = chosen ? { npcId: chosen, memory: true } : bindingFor(i.channel);
  if (!binding) {
    return i.reply({ content: "Nobody lives in this channel. Pick a `character`, or post in one of the town's channels.", flags: MessageFlags.Ephemeral });
  }
  if (lockOrCooldown(player.id)) return i.reply({ content: "Slow down, traveller. One thing at a time.", flags: MessageFlags.Ephemeral });
  try {
    await i.deferReply();
    const message = i.options.getString("message", true);
    await playTurn({ player, npcId: binding.npcId, message, memory: binding.memory }, (content) =>
      i.editReply({ content: `> ${message.slice(0, 300)}\n${content}` }),
    );
  } finally {
    release(player.id);
  }
}

async function onJournal(i: ChatInputCommandInteraction) {
  const player = activePlayer(i.user.id);
  if (!player) return i.reply({ content: CONSENT, flags: MessageFlags.Ephemeral });
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const only = i.options.getString("character");
  const npcs = only ? [getCharacter(only)] : Object.values(CHARACTERS);
  const sections = await Promise.all(
    npcs.map(async (npc) => {
      const mems = await memory.journal(npc.id, player.id, player.name, only ? 15 : 6);
      const att = db.getAttitude(player.id, npc.id) ?? 0;
      const head = `**${npc.emoji} ${npc.name}**: ${attitudeLabel(att)} (${att >= 0 ? "+" : ""}${att})`;
      return mems.length ? `${head}\n${mems.map(journalLine).join("\n")}` : `${head}\n- *doesn't remember you yet*`;
    }),
  );
  const footer = memory.degraded ? "\n-# ⚠️ Walrus Memory was slow to answer; some memories may be missing." : "\n-# Each 🔗 opens the encrypted memory blob on Walruscan.";
  return i.editReply(fit(`**What ${TOWN} remembers about ${player.name}**\n\n${sections.join("\n\n")}`, footer));
}

async function onRumours(i: ChatInputCommandInteraction) {
  await i.deferReply();
  const rumours = await memory.rumours(8);
  const body = rumours.length ? rumours.map((m) => `- ${m.text}`).join("\n") : "- *Quiet times. Nobody's talking about anything yet.*";
  return i.editReply(fit(`🍺 **Overheard at the Drowned Lantern**\n${body}`));
}

async function onOptOut(i: ChatInputCommandInteraction) {
  if (!db.getPlayer(i.user.id)) return i.reply({ content: "You haven't joined, so nothing is stored about you.", flags: MessageFlags.Ephemeral });
  db.optOut(i.user.id);
  return i.reply({
    content:
      "Done. The characters will no longer talk to you or store anything new, and memories not yet uploaded were cancelled. " +
      "Memories already written to Walrus are encrypted and only this game can read them; they can't be fully erased from Walrus storage, " +
      "but the game won't use them unless you `/join` again.",
    flags: MessageFlags.Ephemeral,
  });
}

// ---------- the turn ----------
/**
 * Reply first (fast), then decide what to remember in the background and update the footer.
 * The footer makes memory visible: how many memories shaped the reply and how many new ones were kept.
 */
async function playTurn(input: TurnInput, send: (content: string) => Promise<Message>): Promise<void> {
  const npc = getCharacter(input.npcId);
  const t = await game.respond(input);
  const head = `**${npc.emoji} ${npc.name}:** ${t.reply}`;
  const sent = await send(fit(head, `\n${footer(input, t)}`));

  let l: LearnResult | undefined;
  try {
    l = await game.learn(input, t);
    if (input.memory) await sent.edit(fit(head, `\n${footer(input, t, l)}`)).catch(logError);
  } catch (err) {
    logError(err);
  } finally {
    game.log(input, t, l);
  }
}

function footer(input: TurnInput, t: TurnResult, l?: LearnResult): string {
  if (!input.memory) return "-# 🫥 memory off: this is the amnesiac twin, for comparison";
  const parts = [`🧠 remembered ${t.recalled.length}`];
  if (t.degraded) parts.push("⚠️ memory was slow");
  if (l) {
    if (l.facts.length) parts.push(`will remember ${l.facts.length} new`);
    if (l.attitudeAfter !== l.attitudeBefore) {
      const d = l.attitudeAfter - l.attitudeBefore;
      parts.push(`${getCharacter(input.npcId).name} feels ${attitudeLabel(l.attitudeAfter)} (${d > 0 ? "+" : ""}${d})`);
    }
    if (l.dropped.length) parts.push(`🔒 skipped ${l.dropped.length} that looked like personal info`);
  } else {
    parts.push("thinking about what to remember…");
  }
  return `-# ${parts.join(" · ")}`;
}

// ---------- helpers ----------
function bindingFor(channel: unknown): ChannelBinding | undefined {
  if (!channel || typeof channel !== "object") return undefined;
  const ch = channel as { type?: ChannelType; name?: string; parent?: { name?: string } | null; isThread?: () => boolean };
  // Threads inside a character's channel belong to that character too.
  const name = ch.isThread?.() ? ch.parent?.name : ch.name;
  return name ? config.discord.channels.get(name.toLowerCase()) : undefined;
}

function activePlayer(userId: string): Player | undefined {
  const p = db.getPlayer(userId);
  return p && !p.opted_out ? { id: p.user_id, name: p.name } : undefined;
}

/** Returns true if the player must wait (a turn is in flight, or they're posting too fast). */
function lockOrCooldown(userId: string): boolean {
  if (busy.has(userId) || Date.now() - (lastTurn.get(userId) ?? 0) < COOLDOWN_MS) return true;
  busy.add(userId);
  lastTurn.set(userId, Date.now());
  return false;
}

function release(userId: string): void {
  busy.delete(userId);
}

function journalLine(m: Memory): string {
  const link = m.blobId ? ` [🔗](<${walruscanBlobUrl(m.blobId)}>)` : "";
  return `- ${m.text}${link}`;
}

/** Keep a message under Discord's 2000-character limit, always keeping the suffix. */
function fit(body: string, suffix = ""): string {
  const room = DISCORD_LIMIT - suffix.length;
  return (body.length > room ? `${body.slice(0, room - 1)}…` : body) + suffix;
}

function logError(err: unknown): void {
  console.error("[discord]", err instanceof Error ? err.stack ?? err.message : err);
}

// ---------- lifecycle ----------
let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[discord] ${signal}: flushing memories and shutting down…`);
  await client.destroy();
  await app.shutdown();
  backup?.stop();
  await backup?.save(db).catch(logError);
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("unhandledRejection", logError);

await client.login(requireEnv("DISCORD_TOKEN"));
