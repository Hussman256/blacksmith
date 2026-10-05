import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config, requireEnv } from "./config.js";

const rest = new REST().setToken(requireEnv("DISCORD_TOKEN"));
const clientId = requireEnv("DISCORD_CLIENT_ID");

// A guild registration shows up instantly; a global one can take up to an hour.
const route = config.discord.guildId
  ? Routes.applicationGuildCommands(clientId, config.discord.guildId)
  : Routes.applicationCommands(clientId);

const res = (await rest.put(route, { body: commands })) as unknown[];
console.log(`Registered ${res.length} slash commands ${config.discord.guildId ? `to guild ${config.discord.guildId}` : "globally"}.`);
