import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDescriptor } from "../openai/chat.js";
import type { VerboseLogger } from "./logger.js";

// Tool config shape accepted by every provider's `makeHandler` /
// `registerOnServer`. Provider modules validate the precise shape they
// accept; the bin treats configs uniformly through this surface.
export interface AnyProviderConfig {
  name?: string;
  description?: string;
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  reasoning_effort?: "low" | "medium" | "high";
  requestTimeoutMs?: number;
  logger?: VerboseLogger;
}

// Tools are typed against their own config shape. The bin treats them
// uniformly as `ToolDescriptor<AnyProviderConfig, unknown>` since it only
// invokes `makeHandler` + `desugar` and never touches handler-specific
// surface.
export type AnyTool = ToolDescriptor<AnyProviderConfig, unknown>;

export interface ProviderEntry {
  /** Mount all of this provider's API tools on an `McpServer`. */
  registerOnServer: (server: McpServer, config: AnyProviderConfig) => void;
  /** CLI one-shot tool descriptors keyed by tool name. */
  tools: Record<string, AnyTool>;
}

export type ProviderName = "openai" | "anthropic";

type Loader = () => Promise<ProviderEntry>;

const loaders: Record<ProviderName, Loader> = {
  openai: async () => {
    const mod = await import("../openai/index.js");
    return {
      registerOnServer: mod.registerOpenAIProvider as ProviderEntry["registerOnServer"],
      tools: {
        "chat-completions": mod.openAIChatTool as AnyTool,
        responses: mod.openAIResponsesTool as AnyTool,
      },
    };
  },
  anthropic: async () => {
    const mod = (await import("../anthropic/index.js")) as {
      registerAnthropicProvider: ProviderEntry["registerOnServer"];
      anthropicMessagesTool: AnyTool;
    };
    return {
      registerOnServer: mod.registerAnthropicProvider,
      tools: {
        messages: mod.anthropicMessagesTool,
      },
    };
  },
};

export const providerNames: readonly ProviderName[] = Object.keys(loaders) as ProviderName[];

export async function resolveProvider(name: string): Promise<ProviderEntry | undefined> {
  const loader = (loaders as Record<string, Loader | undefined>)[name];
  if (!loader) return undefined;
  return loader();
}

export async function resolveProviderTool(
  provider: string,
  tool: string,
): Promise<AnyTool | undefined> {
  const entry = await resolveProvider(provider);
  return entry?.tools[tool];
}
