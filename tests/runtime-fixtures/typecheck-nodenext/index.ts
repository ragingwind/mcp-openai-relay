// Exercise every public subpath of `ai-relay` under
// `moduleResolution: "nodenext"`. Used by the publish-contract test.

import { verifyBearer } from "ai-relay";
import type { AnthropicMessagesConfig, AnthropicMessagesResult } from "ai-relay/anthropic";
import { makeAnthropicMessagesHandler, registerAnthropicMessages } from "ai-relay/anthropic";
import { verifyBearer as verifyBearerSub } from "ai-relay/auth";
import { loadConfig } from "ai-relay/env";
import type { GoogleGenerateContentConfig, GoogleGenerateContentResult } from "ai-relay/google";
import { makeGoogleGenerateContentHandler, registerGoogleGenerateContent } from "ai-relay/google";
import type { OpenAIChatConfig, OpenAIChatResult, ToolDescriptor } from "ai-relay/openai";
import { makeOpenAIChatHandler, registerOpenAIChat } from "ai-relay/openai";

const _ok: boolean = verifyBearer("a", "a") && verifyBearerSub("b", "b");

const _cfg: OpenAIChatConfig = { apiKey: "k", model: "gpt-4o-mini" };
const _handler = makeOpenAIChatHandler(_cfg);
const _register: typeof registerOpenAIChat = registerOpenAIChat;

const _acfg: AnthropicMessagesConfig = { apiKey: "k", model: "claude-sonnet-4-5" };
const _ahandler = makeAnthropicMessagesHandler(_acfg);
const _aregister: typeof registerAnthropicMessages = registerAnthropicMessages;

const _gcfg: GoogleGenerateContentConfig = { apiKey: "k", model: "gemini-2.0-flash" };
const _ghandler = makeGoogleGenerateContentHandler(_gcfg);
const _gregister: typeof registerGoogleGenerateContent = registerGoogleGenerateContent;

const _loaded = loadConfig({ env: { AI_RELAY_API_KEY: "x" } });
const _providers = _loaded.providers.length;

const _result: OpenAIChatResult | undefined = undefined;
const _aresult: AnthropicMessagesResult | undefined = undefined;
const _gresult: GoogleGenerateContentResult | undefined = undefined;
const _tool: ToolDescriptor | undefined = undefined;

export {
  _ahandler,
  _aregister,
  _aresult,
  _ghandler,
  _gregister,
  _gresult,
  _handler,
  _ok,
  _providers,
  _register,
  _result,
  _tool,
};
