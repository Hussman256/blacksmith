# Blacksmith

A Discord text game where the people of a small fantasy town remember you between sessions, across days and devices, using [Walrus Memory](https://memory.walrus.xyz).

Insult Brannoc the blacksmith on Monday and on Wednesday he still remembers, and charges you more for it. Tell Mira the innkeeper where you're headed and she asks how the trip went. Start a brawl in public and Captain Hale has already heard about it.

Built for Walrus Session 8, "Chatbots That Remember".

## The characters

| Channel | Character | Remembers |
|---|---|---|
| `#forge` | ⚒️ **Brannoc**, the blacksmith | insults, praise, debts, orders, promises. His prices follow his attitude toward you. |
| `#drowned-lantern` | 🍺 **Mira**, the innkeeper | your stories, your plans, your tab. She also spreads rumours. |
| `#barracks` | 🛡️ **Captain Hale**, the town watch | crimes, help you gave the watch, bounties |
| `#forge-no-memory` | ⚒️ Brannoc with memory **off** | nothing. Use it for side-by-side comparison. |

Every reply ends with a footer like `🧠 remembered 4 · will remember 1 new · Brannoc feels wary (-1)`, so you can see the memory at work. `/journal` shows what each character remembers about you, with a Walruscan link for every memory.

## How memory works

```
player message
   │
   ├─ recall (3 in parallel, Walrus Memory)
   │    1. memories relevant to the message          (private namespace, distance < 0.75)
   │    2. "who is this player to me"                (private namespace, newest first)
   │    3. town rumours relevant to the message      (world namespace)
   │    + facts saved in the last few minutes that the relayer may not have indexed yet
   │
   ├─ reply (LLM, in character, with prices adjusted for attitude)
   │
   └─ learn (LLM extracts 0–3 short facts + an attitude change)
        → safety filter (drops anything that looks like personal data or secrets)
        → SQLite outbox → rememberAndWait (retries, backoff, idempotency key)
```

- **Namespaces.** Each character has a separate memory of each player, in `blacksmith:npc:<character>:player:<discordUserId>`. Public deeds go to `blacksmith:world` as rumours that every character can hear. Secrets are always kept private. The namespace is built only from the Discord user ID, never from message text, so one player can't make a character reveal another player's private memories.
- **Store facts, not chat logs.** Memories are short sentences written from the character's point of view, for example *"Alice called my steel brittle and refused to pay full price."*
- **The newest fact wins.** Walrus Memory is append-only, so a change is written as a new fact (*"Brannoc's attitude toward Alice is now -2 (resentful) because she insulted my steel."*), and recall uses `sort: "recent"`. Attitude is cached in SQLite, but it can be rebuilt from Walrus if that database is lost.
- **Write-ahead outbox.** Every fact is saved to SQLite before it goes to the relayer. If the relayer has a problem, the memory is delayed, not lost.
- **Privacy.** Players must `/join` before anything is stored. Walrus blobs can be removed from search but not erased, so a regex filter drops emails, phone numbers, keys and tokens before any write.

## Setup

Requires Node.js 22.13 or later (the game uses `node:sqlite`, so there are no native builds).

```bash
git clone <this repo> && cd blacksmith
npm install
cp .env.example .env    # then fill it in, see below
npm run check           # health check, one write and read on Walrus, one LLM call
npm test                # offline tests, using the SDK's MemWalMock
```

### 1. Walrus Memory
Create an account and a delegate key at <https://memory.walrus.xyz>. Put them in `MEMWAL_ACCOUNT_ID` and `MEMWAL_PRIVATE_KEY`, and keep them on the server only.

### 2. LLM
Any OpenAI-compatible endpoint works. The default is Groq running `qwen/qwen3.8-27b`. Get a key at <https://console.groq.com> and put it in `LLM_API_KEY`.

### 3. Discord
1. At <https://discord.com/developers/applications>, create a **New Application**.
2. On the **Bot** tab, use **Reset Token** and put the token in `DISCORD_TOKEN`. Under **Privileged Gateway Intents**, turn on **Message Content Intent**.
3. Put the **Application ID** from General Information in `DISCORD_CLIENT_ID`.
4. Invite the bot from **OAuth2 → URL Generator**. Scopes: `bot` and `applications.commands`. Permissions: View Channels, Send Messages, Read Message History, Embed Links.
5. Turn on Developer Mode in Discord, right-click your server, choose **Copy Server ID**, and put it in `DISCORD_GUILD_ID`.
6. Create text channels named `forge`, `drowned-lantern`, `barracks` and `forge-no-memory`. You can change these names with `CHANNELS` in `.env`.

```bash
npm run register   # register the slash commands
npm run bot        # start the bot
```

### Play without Discord
```bash
npm run play                    # terminal version: /npc mira, /memory off, /journal, /rumours, /quit
MEMWAL_MODE=mock npm run play   # fully offline memory (an LLM key is still needed)
```

## Commands

| Command | |
|---|---|
| `/join name:<character name>` | Agree to be remembered, and pick your in-game name |
| `/talk message:<text> [character]` | Talk without posting in a channel |
| `/journal [character]` | Only you can see it: what each character remembers about you, with Walruscan links |
| `/rumours` | What the town is gossiping about |
| `/optout` | Stop playing. Nothing new is stored, and the game stops using your memories. |
| `/help` | How to play |

## Deploy

The bot is a single long-running Node process. It needs a persistent disk for `data/`, which holds the outbox, consent records and the turn log. Railway, Fly.io or any small VPS works:

```bash
npm ci && npm run register && npm run bot
```

Set the same environment variables as in `.env`. Mount a volume at `DATA_DIR`.

## Evidence

`npm run stats` writes `data/evidence.md`. It contains:
- stored memories per player
- turns with memory on and off
- active days per player
- every "cross-session recall moment", where a memory more than 6 hours old shaped a reply, with the message and the reply

## Project layout

```
src/
  characters.ts  the three characters, attitude labels, price scaling
  game.ts        respond (recall → reply) and learn (extract → filter → outbox), plus the prompts
  memory.ts      Walrus Memory client, namespaces, recall per turn, write-ahead outbox
  db.ts          SQLite: players and consent, attitude cache, outbox, turn log
  safety.ts      personal-data and secret filter
  llm.ts         OpenAI-compatible client
  app.ts         shared startup
  discord.ts     the bot
  commands.ts    slash command definitions
  register-commands.ts, cli.ts, check.ts, stats.ts
test/game.test.ts  memory behaviour tests against MemWalMock
```

## License
Apache-2.0
