import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

export interface ChannelBinding {
  npcId: string;
  memory: boolean;
}

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function parseChannels(raw: string): Map<string, ChannelBinding> {
  const map = new Map<string, ChannelBinding>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [channel, npcId, memory = "on"] = entry.split(":").map((s) => s.trim());
    if (!channel || !npcId) throw new Error(`Bad CHANNELS entry "${entry}"`);
    map.set(channel.toLowerCase(), { npcId, memory: memory !== "off" });
  }
  return map;
}

export const config = {
  discord: {
    token: env("DISCORD_TOKEN"),
    clientId: env("DISCORD_CLIENT_ID"),
    guildId: env("DISCORD_GUILD_ID"),
    channels: parseChannels(
      env("CHANNELS", "forge:brannoc:on,drowned-lantern:mira:on,barracks:hale:on,forge-no-memory:brannoc:off"),
    ),
  },
  memwal: {
    mode: env("MEMWAL_MODE", "live") as "live" | "mock",
    privateKey: env("MEMWAL_PRIVATE_KEY"),
    accountId: env("MEMWAL_ACCOUNT_ID"),
    serverUrl: env("MEMWAL_SERVER_URL", "https://relayer.memory.walrus.xyz"),
    nsPrefix: env("MEMWAL_NS_PREFIX", "blacksmith"),
    maxDistance: Number(env("MEMWAL_MAX_DISTANCE", "0.75")),
  },
  llm: {
    baseURL: env("LLM_BASE_URL", "https://api.groq.com/openai/v1"),
    apiKey: env("LLM_API_KEY"),
    model: env("LLM_MODEL", "qwen/qwen3.8-27b"),
    extractModel: env("LLM_EXTRACT_MODEL") || env("LLM_MODEL", "qwen/qwen3.8-27b"),
  },
  dataDir: env("DATA_DIR", "./data"),
};

export function walruscanBlobUrl(blobId: string): string {
  return `https://walruscan.com/mainnet/blob/${blobId}`;
}
