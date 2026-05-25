// ai-relay/google — Google Gemini provider.

export type { CreatedGoogleClient, GoogleClientConfig } from "./client.js";
export { createGoogleClient } from "./client.js";
export type {
  GoogleGenerateContentConfig,
  GoogleGenerateContentHandler,
  GoogleGenerateContentHandlerBundle,
  GoogleGenerateContentInput,
  GoogleGenerateContentResult,
  GoogleGenerateContentSchema,
  GoogleGenerateContentStructured,
  GoogleUsage,
} from "./generate-content.js";
export {
  googleGenerateContentTool,
  makeGoogleGenerateContentHandler,
  makeGoogleGenerateContentSchema,
  mapGoogleError,
  registerGoogleGenerateContent,
  registerGoogleProvider,
} from "./generate-content.js";
