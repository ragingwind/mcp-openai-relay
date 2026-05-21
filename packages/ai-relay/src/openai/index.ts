// ai-relay/openai — OpenAI provider (Chat Completions + Responses).
//
// Compatible with any OpenAI Chat Completions-shaped API: OpenAI proper,
// Azure OpenAI, vLLM, Ollama, OpenRouter, Vercel AI Gateway (OpenAI mode).
// The Responses tool targets OpenAI proper (and any compatible upstream
// implementing `/v1/responses`).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type OpenAIChatConfig, registerOpenAIChat } from "./chat.js";
import { type OpenAIResponsesConfig, registerOpenAIResponses } from "./responses.js";

export type {
  OpenAIChatConfig,
  OpenAIChatHandler,
  OpenAIChatHandlerBundle,
  OpenAIChatInput,
  OpenAIChatResult,
  OpenAIChatSchema,
  OpenAIChatStructured,
  OpenaiUsage,
  ToolDescriptor,
} from "./chat.js";
export {
  makeOpenAIChatHandler,
  makeOpenAIChatSchema,
  mapOpenAIError,
  openAIChatTool,
  registerOpenAIChat,
} from "./chat.js";
export type {
  CreatedOpenAIClient,
  OpenAIClientConfig,
  RequestScope,
} from "./client.js";
export { createOpenAIClient } from "./client.js";
export type {
  OpenAIResponsesConfig,
  OpenAIResponsesHandler,
  OpenAIResponsesHandlerBundle,
  OpenAIResponsesInput,
  OpenAIResponsesResult,
  OpenAIResponsesSchema,
  OpenAIResponsesStructured,
} from "./responses.js";
export {
  makeOpenAIResponsesHandler,
  makeOpenAIResponsesSchema,
  openAIResponsesOutputSchema,
  openAIResponsesTool,
  registerOpenAIResponses,
} from "./responses.js";

export type OpenAIProviderConfig = OpenAIChatConfig & {
  /** Reasoning effort forwarded only to the Responses tool. Ignored by the
   *  Chat Completions tool. */
  reasoning_effort?: OpenAIResponsesConfig["reasoning_effort"];
};

export function registerOpenAIProvider(server: McpServer, config: OpenAIProviderConfig): void {
  registerOpenAIChat(server, config);
  const { reasoning_effort, ...rest } = config;
  const responsesConfig: OpenAIResponsesConfig =
    reasoning_effort !== undefined ? { ...rest, reasoning_effort } : rest;
  registerOpenAIResponses(server, responsesConfig);
}
