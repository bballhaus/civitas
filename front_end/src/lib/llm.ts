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
  const provider = config.llm.provider;

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
