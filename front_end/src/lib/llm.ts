/**
 * Provider-agnostic LLM abstraction.
 * Supports Groq, OpenAI, and Anthropic — switch via civitas.config.json.
 */
import { config } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  provider?: "groq" | "openai" | "anthropic";
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
}

// ---------------------------------------------------------------------------
// Singleton clients (lazy-init)
// ---------------------------------------------------------------------------
let _groqClient: import("groq-sdk").default | null = null;
let _openaiClient: import("openai").default | null = null;
let _anthropicClient: import("@anthropic-ai/sdk").default | null = null;

function getGroqClient() {
  if (!_groqClient) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Groq = require("groq-sdk").default ?? require("groq-sdk");
    _groqClient = new Groq({ apiKey: config.llm.groqApiKey });
  }
  return _groqClient!;
}

function getOpenAIClient() {
  if (!_openaiClient) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const OpenAI = require("openai").default ?? require("openai");
    _openaiClient = new OpenAI({ apiKey: config.llm.openaiApiKey });
  }
  return _openaiClient!;
}

function getAnthropicClient() {
  if (!_anthropicClient) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk");
    _anthropicClient = new Anthropic({ apiKey: config.llm.anthropicApiKey });
  }
  return _anthropicClient!;
}

// ---------------------------------------------------------------------------
// Provider dispatch
// ---------------------------------------------------------------------------
async function callGroq(
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): Promise<string> {
  const client = getGroqClient();
  const completion = await client.chat.completions.create({
    model: opts.model ?? config.llm.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  });
  return completion.choices[0]?.message?.content ?? "";
}

async function callOpenAI(
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): Promise<string> {
  const client = getOpenAIClient();
  const completion = await client.chat.completions.create({
    model: opts.model ?? config.llm.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  });
  return completion.choices[0]?.message?.content ?? "";
}

async function callAnthropic(
  messages: ChatMessage[],
  opts: ChatCompletionOptions
): Promise<string> {
  const client = getAnthropicClient();
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const response = await client.messages.create({
    model: opts.model ?? config.llm.model,
    system: systemMsg?.content,
    messages: nonSystemMsgs.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    temperature: opts.temperature,
    max_tokens: opts.maxTokens ?? 1024,
  });

  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function chatCompletion(
  messages: ChatMessage[],
  options?: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const opts = options ?? {};
  const provider = opts.provider ?? config.llm.provider;

  let content: string;
  switch (provider) {
    case "openai":
      content = await callOpenAI(messages, opts);
      break;
    case "anthropic":
      content = await callAnthropic(messages, opts);
      break;
    case "groq":
    default:
      content = await callGroq(messages, opts);
      break;
  }

  return { content };
}

/**
 * Token-by-token streaming variant. Yields plain text chunks as the model
 * produces them — same content as chatCompletion() once fully drained, but
 * the first token typically lands in 200-500ms instead of waiting for the
 * full 1-3s completion. Use for any user-facing LLM output where progressive
 * rendering improves perceived latency (match summaries, requirements
 * summaries, anything paragraph-shaped).
 *
 * Provider support: Anthropic streams natively. Groq/OpenAI fall back to
 * non-streaming for now and emit the full response as one chunk — callers
 * see the same contract, just no progressive rendering.
 */
export async function* chatCompletionStream(
  messages: ChatMessage[],
  options?: ChatCompletionOptions
): AsyncGenerator<string, void, void> {
  const opts = options ?? {};
  const provider = opts.provider ?? config.llm.provider;

  if (provider !== "anthropic") {
    const result = await chatCompletion(messages, opts);
    if (result.content) yield result.content;
    return;
  }

  const client = getAnthropicClient();
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const stream = client.messages.stream({
    model: opts.model ?? config.llm.model,
    system: systemMsg?.content,
    messages: nonSystemMsgs.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    temperature: opts.temperature,
    max_tokens: opts.maxTokens ?? 1024,
  });

  // Iterate raw events for broad SDK-version compatibility (older SDKs
  // don't have stream.textStream). We only care about content_block_delta
  // events carrying text deltas; the rest (message_start, message_stop,
  // tool_use blocks, etc.) are dropped.
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta" &&
      event.delta.text
    ) {
      yield event.delta.text;
    }
  }
}
