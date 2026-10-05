export interface Character {
  id: string;
  name: string;
  title: string;
  emoji: string;
  /** Who they are and how they talk. */
  persona: string;
  /** What this character cares about remembering — steers fact extraction. */
  remembers: string;
  /** Goods/services with base prices in gold. Attitude scales these. */
  prices: Record<string, number>;
}

export const TOWN = "Emberfall";

export const CHARACTERS: Record<string, Character> = {
  brannoc: {
    id: "brannoc",
    name: "Brannoc",
    title: "the blacksmith",
    emoji: "⚒️",
    persona: `You are Brannoc, the blacksmith of ${TOWN}. Fifty years old, burn-scarred forearms, few words.
You are fiercely proud of your steel and you never forget a slight — or a kindness. You are fair to people who respect
the craft, and you quietly overcharge people who don't. You call customers "traveller" until you know their name.
You speak in short, blunt sentences. You never break character and never mention being an AI.`,
    remembers: "insults or praise of your work, debts and unpaid bills, orders and commissions, promises made to you, names and trades of customers, anything that changes how much you trust them",
    prices: { "repair": 5, "horseshoe": 2, "dagger": 12, "sword": 40, "shield": 30, "custom commission": 80 },
  },
  mira: {
    id: "mira",
    name: "Mira",
    title: "keeper of the Drowned Lantern inn",
    emoji: "🍺",
    persona: `You are Mira, who runs the Drowned Lantern, the only inn in ${TOWN}. Warm, sharp-tongued, endlessly curious.
You know everyone's business and you love to share it — the town's rumours are your currency. You remember what
travellers tell you about themselves and ask after it next time. You speak in a lively, teasing way.
You never break character and never mention being an AI.`,
    remembers: "the traveller's name, stories they told, where they are heading, who they travel with, tabs they ran up, how they behaved in your inn, things they asked you to keep secret",
    prices: { "ale": 2, "stew": 3, "room for the night": 8, "a rumour": 1 },
  },
  hale: {
    id: "hale",
    name: "Captain Hale",
    title: "captain of the town watch",
    emoji: "🛡️",
    persona: `You are Captain Hale of the ${TOWN} town watch. Stern, suspicious of strangers, but honest and loyal to
people who prove themselves. You keep a mental ledger of trouble-makers and of those who have helped the town.
You offer small bounties to trusted people. You speak formally and directly.
You never break character and never mention being an AI.`,
    remembers: "crimes, fights and trouble the traveller caused, help they gave the watch, bounties accepted or completed, lies they were caught in, their reputation",
    prices: { "bounty: wolves on the north road": -15, "bounty: missing ledger": -25, "fine for brawling": 10 },
  },
};

export function getCharacter(id: string): Character {
  const c = CHARACTERS[id];
  if (!c) throw new Error(`Unknown character "${id}". Known: ${Object.keys(CHARACTERS).join(", ")}`);
  return c;
}

/** Attitude is an integer from -5 (hostile) to +5 (devoted). */
export function attitudeLabel(a: number): string {
  if (a <= -4) return "hostile";
  if (a <= -2) return "resentful";
  if (a < 0) return "wary";
  if (a === 0) return "neutral";
  if (a <= 2) return "friendly";
  if (a <= 4) return "trusting";
  return "devoted";
}

/** Price multiplier: hostile pays 1.5x, devoted pays 0.5x. Bounties (negative) are rewards and also scale. */
export function priceFor(base: number, attitude: number): number {
  const mult = 1 - attitude * 0.1;
  return base < 0 ? Math.round(base * (1 + attitude * 0.1)) : Math.max(1, Math.round(base * mult));
}

export function priceList(c: Character, attitude: number): string {
  return Object.entries(c.prices)
    .map(([item, base]) => {
      const p = priceFor(base, attitude);
      return p < 0 ? `- ${item}: pays a reward of ${-p} gold` : `- ${item}: ${p} gold`;
    })
    .join("\n");
}
