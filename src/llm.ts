import OpenAI from "openai";
import { config } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Minimal LLM surface so tests can swap in a fake. */
export interface Llm {
  chat(messages: ChatMessage[], opts?: { json?: boolean; model?: string; temperature?: number; maxTokens?: number }): Promise<string>;
}

export function createLlm(): Llm {
  if (!config.llm.apiKey) throw new Error("Missing LLM_API_KEY (see .env.example)");
  const client = new OpenAI({
    baseURL: config.llm.baseURL,
    apiKey: config.llm.apiKey,
    // OpenRouter attribution headers; other providers ignore them.
    defaultHeaders: { "HTTP-Referer": "https://github.com/blacksmith-walrus", "X-Title": "Blacksmith" },
  });
  // Routers like openrouter/free pick a different model per request; log whenever it changes
  // so the model behind each session is on record.
  let lastServed = "";

  return {
    async chat(messages, opts = {}) {
      const request = {
        model: opts.model ?? config.llm.model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 400,
      };
      let res;
      try {
        res = await client.chat.completions.create(
          opts.json ? { ...request, response_format: { type: "json_object" as const } } : request,
        );
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 429) {
          throw new Error(`LLM rate limit reached (${request.model}). Free OpenRouter accounts get 50 requests/day; try later or add credit.`);
        }
        // Not every free model supports JSON mode; the prompt asks for JSON anyway and parseJsonObject copes.
        if (!opts.json || (status !== 400 && status !== 404)) throw err;
        res = await client.chat.completions.create(request);
      }
      if (res.model && res.model !== lastServed) {
        lastServed = res.model;
        console.log(`[llm] served by ${res.model}`);
      }
      return stripThinking(res.choices[0]?.message?.content ?? "");
    },
  };
}

/** Some free reasoning models put their chain of thought in <think> tags; players should never see it. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
}

/** Pull the first JSON object out of a model response, tolerating code fences and chatter. */
export function parseJsonObject<T>(raw: string): T | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
