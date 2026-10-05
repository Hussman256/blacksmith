import { config, walruscanBlobUrl } from "./config.js";
import { createBackend } from "./memory.js";
import { createLlm } from "./llm.js";

/**
 * End-to-end smoke test against the real services: relayer health, one write, one read back, one LLM call.
 * Run this before inviting players: `npm run check`.
 */
let ok = true;
const step = async (label: string, fn: () => Promise<string>) => {
  const t0 = Date.now();
  try {
    console.log(`✅ ${label}: ${await fn()} (${Date.now() - t0} ms)`);
  } catch (err) {
    ok = false;
    console.error(`❌ ${label}: ${(err as Error).message}`);
  }
};

console.log(`Walrus Memory: ${config.memwal.mode === "mock" ? "MOCK (offline)" : config.memwal.serverUrl}`);
const backend = createBackend();
const namespace = `${config.memwal.nsPrefix}:healthcheck`;
const fact = `Healthcheck: the forge fire was lit at ${new Date().toISOString()}.`;

await step("relayer health", async () => JSON.stringify(await backend.health()));

let blobId = "";
await step("remember (rememberAndWait)", async () => {
  const res = await backend.rememberAndWait(fact, namespace, { timeoutMs: 90_000 });
  blobId = res.blob_id;
  return `blob ${blobId}\n   ${walruscanBlobUrl(blobId)}`;
});

await step("recall", async () => {
  const res = await backend.recall({ query: "When was the forge fire lit?", namespace, limit: 3, sort: "recent" });
  const hit = res.results.find((r) => r.text === fact);
  if (!hit) throw new Error(`fact not found in ${res.results.length} results (indexing lag? try again in a minute)`);
  return `found it, distance ${hit.distance.toFixed(3)}`;
});

await step(`LLM (${config.llm.model})`, async () => {
  const reply = await createLlm().chat([{ role: "user", content: "Reply with exactly: the anvil rings" }], { maxTokens: 10, temperature: 0 });
  return JSON.stringify(reply);
});

console.log(ok ? "\nAll good. Emberfall is ready." : "\nSome checks failed; see above.");
process.exit(ok ? 0 : 1);
