import { test } from "node:test";
import assert from "node:assert/strict";
import { MemWalMock } from "@mysten-incubation/memwal";
import { Db } from "../src/db.js";
import { Game, type Player } from "../src/game.js";
import type { ChatMessage, Llm } from "../src/llm.js";
import { MemoryService, ns, Outbox } from "../src/memory.js";

/** Fake LLM: records every system prompt and answers extraction calls from a script. */
class FakeLlm implements Llm {
  prompts: string[] = [];
  extractions: object[] = [];
  async chat(messages: ChatMessage[], opts: { json?: boolean } = {}): Promise<string> {
    if (opts.json) return JSON.stringify(this.extractions.shift() ?? { facts: [], attitude_change: 0 });
    this.prompts.push(messages[0]!.content);
    return "*grunts* What do you want?";
  }
  get lastPrompt(): string {
    return this.prompts.at(-1) ?? "";
  }
}

/**
 * A fresh world. MemWalMock scores recall by word overlap rather than embeddings,
 * so the relevance cutoff is relaxed here; namespace isolation is identical to the real relayer.
 */
function world(backend = MemWalMock.create(), db = new Db(":memory:")) {
  const llm = new FakeLlm();
  const memory = new MemoryService(backend, db, 1.01);
  const outbox = new Outbox(backend, db);
  const game = new Game(db, memory, llm);
  return { backend, db, llm, memory, outbox, game };
}

async function drain(outbox: Outbox, db: Db) {
  while (db.duePending(1).length) await outbox.flush();
}

const alice: Player = { id: "111", name: "Alice" };
const bob: Player = { id: "222", name: "Bob" };

test("facts are written to the player's private namespace and recalled on the next visit", async () => {
  const w = world();
  w.llm.extractions.push({ facts: [{ text: "Alice ordered a silver dagger and paid 5 gold upfront.", scope: "private", kind: "order" }] });
  const r = await w.game.turn({ player: alice, npcId: "brannoc", message: "Forge me a silver dagger, here's 5 gold", memory: true });
  assert.equal(r.facts.length, 1);

  await drain(w.outbox, w.db);
  const stored = await w.backend.recall({ query: "silver dagger", namespace: ns.private("brannoc", alice.id) });
  assert.equal(stored.results[0]?.text, "Alice ordered a silver dagger and paid 5 gold upfront.");

  // New process, same Walrus: the local DB is gone but the memory isn't.
  const later = world(w.backend);
  await later.game.turn({ player: alice, npcId: "brannoc", message: "Is my dagger ready?", memory: true });
  assert.match(later.llm.lastPrompt, /silver dagger and paid 5 gold/);
});

test("facts that look like personal data are never written", async () => {
  const w = world();
  w.llm.extractions.push({
    facts: [
      { text: "Alice says her email is alice@example.com for the order.", scope: "private", kind: "identity" },
      { text: "Alice is a travelling herbalist from the east.", scope: "private", kind: "identity" },
    ],
  });
  const r = await w.game.turn({ player: alice, npcId: "mira", message: "hi", memory: true });
  assert.equal(r.facts.length, 1);
  assert.equal(r.dropped.length, 1);
  await drain(w.outbox, w.db);
  const all = await w.backend.recall({ query: "Alice email herbalist", namespace: ns.private("mira", alice.id) });
  assert.ok(all.results.every((m) => !m.text.includes("@")));
});

test("the memory-off twin neither recalls nor stores anything", async () => {
  const w = world();
  w.llm.extractions.push({ facts: [{ text: "Alice called Brannoc's steel brittle.", scope: "private", kind: "insult" }], attitude_change: -2 });
  await w.game.turn({ player: alice, npcId: "brannoc", message: "Your steel is brittle", memory: true });
  await drain(w.outbox, w.db);

  const twin = await w.game.turn({ player: alice, npcId: "brannoc", message: "Remember me?", memory: false });
  assert.equal(twin.recalled.length, 0);
  assert.equal(twin.facts.length, 0);
  assert.equal(twin.attitude, 0);
  assert.match(w.llm.lastPrompt, /no memory of any previous visit/);
  assert.doesNotMatch(w.llm.lastPrompt, /brittle/);
});

test("attitude survives losing the local database because it is stored as a memory", async () => {
  const w = world();
  w.llm.extractions.push({ facts: [], attitude_change: -2, attitude_reason: "she insulted my steel" });
  const r = await w.game.turn({ player: alice, npcId: "brannoc", message: "Your steel is brittle", memory: true });
  assert.equal(r.attitudeAfter, -2);
  await drain(w.outbox, w.db);

  const fresh = world(w.backend);
  assert.equal(await fresh.game.attitude("brannoc", alice, true), -2);
  await fresh.game.turn({ player: alice, npcId: "brannoc", message: "How much for a sword?", memory: true });
  assert.match(fresh.llm.lastPrompt, /sword: 48 gold/); // 40 base, +20% for attitude -2
});

test("public deeds become rumours that other characters hear about", async () => {
  const w = world();
  w.llm.extractions.push({ facts: [{ text: "Word is Alice broke a chair over a guard's back at the inn.", scope: "world", kind: "deed" }] });
  await w.game.turn({ player: alice, npcId: "mira", message: "*smashes a chair over the guard*", memory: true });
  await drain(w.outbox, w.db);

  await w.game.turn({ player: bob, npcId: "hale", message: "Any trouble at the inn lately, Alice and the guard?", memory: true });
  assert.match(w.llm.lastPrompt, /Rumours you've heard[\s\S]*broke a chair/);
  assert.equal((await w.memory.rumours()).length, 1);
});

test("secrets never become rumours, even if the extractor marks them public", async () => {
  const w = world();
  w.llm.extractions.push({ facts: [{ text: "Alice confided she stole the watch ledger.", scope: "world", kind: "secret" }] });
  await w.game.turn({ player: alice, npcId: "mira", message: "Keep this between us...", memory: true });
  await drain(w.outbox, w.db);
  assert.equal((await w.memory.rumours()).length, 0);
});

test("one player's private memories are never shown to another player", async () => {
  const w = world();
  w.llm.extractions.push({ facts: [{ text: "Alice owes Brannoc 30 gold for the shield.", scope: "private", kind: "debt" }] });
  await w.game.turn({ player: alice, npcId: "brannoc", message: "Put the shield on my tab", memory: true });

  // Before and after the outbox flush (pending facts are injected too, so check both).
  await w.game.turn({ player: bob, npcId: "brannoc", message: "Does Alice owe you gold for the shield?", memory: true });
  assert.doesNotMatch(w.llm.lastPrompt, /owes Brannoc 30 gold/);
  await drain(w.outbox, w.db);
  await w.game.turn({ player: bob, npcId: "brannoc", message: "Does Alice owe you gold for the shield?", memory: true });
  assert.doesNotMatch(w.llm.lastPrompt, /owes Brannoc 30 gold/);
  assert.match(w.llm.lastPrompt, /never met this traveller/);
});

test("a fact is usable immediately, before the relayer has indexed it", async () => {
  const w = world();
  w.llm.extractions.push({ facts: [{ text: "Alice promised to bring Brannoc iron ore by Friday.", scope: "private", kind: "promise" }] });
  await w.game.turn({ player: alice, npcId: "brannoc", message: "I'll bring you iron ore by Friday", memory: true });
  // No flush: the fact is still in the outbox.
  await w.game.turn({ player: alice, npcId: "brannoc", message: "What did I just promise?", memory: true });
  assert.match(w.llm.lastPrompt, /iron ore by Friday\. \(just now\)/);
});
