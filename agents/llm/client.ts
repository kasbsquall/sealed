/**
 * Minimal client for any OpenAI-compatible chat endpoint with tool calling. By
 * default it talks to Ollama on this machine, so the agent's mandate is never
 * sent to a third-party model provider. Pointing it at a hosted model is a
 * configuration change, not a code change:
 *
 *   LLM_BASE_URL=http://localhost:11434/v1   LLM_MODEL=qwen2.5:14b-instruct   (default, local)
 *   LLM_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1   LLM_MODEL=qwen3.8-max   LLM_API_KEY=...
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model wrote it. Parsed, and checked, by the caller. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  parameters: object;
}

export interface ChatReply {
  content: string | null;
  toolCalls: ToolCall[];
}

export interface LlmClient {
  readonly model: string;
  /** With `forceTool`, the model must answer by calling that tool. */
  chat(messages: ChatMessage[], tools: ToolDefinition[], forceTool?: string): Promise<ChatReply>;
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return {
    baseUrl: (env.LLM_BASE_URL ?? "http://localhost:11434/v1").replace(/\/$/, ""),
    model: env.LLM_MODEL ?? "qwen2.5:14b-instruct",
    apiKey: env.LLM_API_KEY || undefined,
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 120_000),
  };
}

const toWire = (m: ChatMessage) => {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant") {
    return {
      role: "assistant",
      // Some compatible servers reject a null content on a message without tool calls.
      content: m.toolCalls?.length ? m.content : (m.content ?? ""),
      ...(m.toolCalls?.length
        ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
        : {}),
    };
  }
  return m;
};

export class OpenAICompatibleClient implements LlmClient {
  /** Fallback ids stay unique across turns when a server sends none. */
  private calls = 0;

  constructor(private readonly config: LlmConfig) {}

  get model() {
    return this.config.model;
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[], forceTool?: string): Promise<ChatReply> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: messages.map(toWire),
        temperature: 0.2,
        tools: tools.map((t) => ({ type: "function", function: t })),
        tool_choice: forceTool ? { type: "function", function: { name: forceTool } } : "auto",
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: HTTP ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
    };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error("LLM returned no message");
    const toolCalls = (message.tool_calls ?? []).map((c) => ({
      id: c.id || `call_${++this.calls}`,
      name: c.function?.name ?? "",
      arguments: c.function?.arguments ?? "{}",
    }));
    return { content: message.content ?? null, toolCalls };
  }
}
