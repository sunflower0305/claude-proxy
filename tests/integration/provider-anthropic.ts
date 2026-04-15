import { runAnthropicCompatibilitySuite } from "./lib/anthropic-compat.ts";
import { getProviderDefinitions } from "./lib/providers.ts";

runAnthropicCompatibilitySuite(
  "Testing provider-native Anthropic Messages endpoints",
  getProviderDefinitions().map(({ name, apiKey, baseUrl, model }) => ({
    name,
    apiKey,
    baseUrl,
    model,
  }))
).catch((error) => {
  console.error("Test runner failed:", error);
  process.exit(1);
});
