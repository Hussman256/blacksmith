import { SlashCommandBuilder } from "discord.js";
import { CHARACTERS } from "./characters.js";

const characterChoices = Object.values(CHARACTERS).map((c) => ({ name: `${c.name}, ${c.title}`.slice(0, 100), value: c.id }));

/** Slash command definitions, shared by the bot and register-commands.ts. */
export const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Enter Emberfall: pick your character name and agree to the town remembering you")
    .addStringOption((o) => o.setName("name").setDescription("Your in-game name (not your real name)").setRequired(true).setMinLength(2).setMaxLength(32)),
  new SlashCommandBuilder()
    .setName("talk")
    .setDescription("Say something to a character")
    .addStringOption((o) => o.setName("message").setDescription("What you say").setRequired(true).setMaxLength(1500))
    .addStringOption((o) =>
      o.setName("character").setDescription("Who to talk to (defaults to whoever lives in this channel)").addChoices(...characterChoices),
    ),
  new SlashCommandBuilder()
    .setName("journal")
    .setDescription("See what the characters remember about you (only you can see this)")
    .addStringOption((o) => o.setName("character").setDescription("Only this character").addChoices(...characterChoices)),
  new SlashCommandBuilder().setName("rumours").setDescription("Hear the latest gossip going around Emberfall"),
  new SlashCommandBuilder().setName("optout").setDescription("Stop playing: characters stop remembering and talking to you"),
  new SlashCommandBuilder().setName("help").setDescription("How to play Blacksmith"),
].map((c) => c.toJSON());
