import { runAnthropicCompatibilitySuite } from "./lib/anthropic-compat.ts";

runAnthropicCompatibilitySuite(
  "Testing provider-native Anthropic Messages endpoints",
  [
    {
      name: "DeepSeek",
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl:
        process.env.DEEPSEEK_ANTHROPIC_BASE_URL ||
        "https://api.deepseek.com/anthropic",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    },
    {
      name: "Qwen",
      apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY,
      baseUrl:
        process.env.QWEN_ANTHROPIC_BASE_URL ||
        process.env.DASHSCOPE_ANTHROPIC_BASE_URL ||
        "https://dashscope.aliyuncs.com/apps/anthropic",
      model: process.env.QWEN_MODEL || "qwen3.6-plus",
    },
    {
      name: "GLM",
      apiKey: process.env.GLM_API_KEY,
      baseUrl:
        process.env.GLM_ANTHROPIC_BASE_URL ||
        "https://open.bigmodel.cn/api/anthropic",
      model: process.env.GLM_MODEL || "glm-4",
    },
    {
      name: "MiniMax",
      apiKey: process.env.MINIMAX_API_KEY,
      baseUrl:
        process.env.MINIMAX_ANTHROPIC_BASE_URL ||
        "https://api.minimaxi.com/anthropic",
      model: process.env.MINIMAX_MODEL || "MiniMax-M2.7-highspeed",
    },
    {
      name: "Kimi",
      apiKey: process.env.KIMI_API_KEY || "",
      baseUrl:
        process.env.KIMI_ANTHROPIC_BASE_URL ||
        "https://api.moonshot.cn/anthropic",
      model: process.env.KIMI_MODEL || "kimi-k2.5",
    },
  ]
).catch((error) => {
  console.error("Test runner failed:", error);
  process.exit(1);
});
