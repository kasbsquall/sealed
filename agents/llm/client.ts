/**
 * Minimal client for any OpenAI-compatible chat endpoint with JSON-schema
 * structured output. By default it talks to Ollama on this machine, so the
 * agent's mandate is never sent to a third-party model provider. Pointing it at
 * a hosted model is a configuration change, not a code change:
 *
 *   LLM_BASE_URL=http://localhost:11434/v1   LLM_MODEL=qwen2.5:14b-instruct   (default, local)
 *   LLM_BASE_URL=https://api.openai.com/v1   LLM_MODEL=gpt-6-luna   LLM_API_KEY=...
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface LlmClient {
  readonly model: string;
  chatJson<T>(messages: ChatMessage[], schemaName: string, schema: object): Promise<T>;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return {
    baseUrl: (env.LLM_BASE_URL ?? "http://localhost:11434/v1").replace(/\/$/, ""),
    model: env.LLM_MODEL ?? "qwen2.5:14b-instruct",
    apiKey: env.LLM_API_KEY || undefined,
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 120_000),
  };
}

export class OpenAICompatibleClient implements LlmClient {
  constructor(private readonly config: LlmConfig) {}

  get model() {
    return this.config.model;
  }

  async chatJson<T>(messages: ChatMessage[], schemaName: string, schema: object): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: HTTP ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned no content");
    return JSON.parse(content) as T;
  }
}
