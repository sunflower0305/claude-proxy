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
      model: process.env.DEEPSEEK_ANTHROPIC_MODEL || "deepseek-chat",
    },
    {
      name: "DashScope",
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseUrl:
        process.env.DASHSCOPE_ANTHROPIC_BASE_URL ||
        "https://dashscope.aliyuncs.com/apps/anthropic",
      model: process.env.DASHSCOPE_ANTHROPIC_MODEL || "qwen3.6-plus",
    },
    {
      name: "GLM",
      apiKey: process.env.GLM_API_KEY,
      baseUrl:
        process.env.GLM_ANTHROPIC_BASE_URL ||
        "https://open.bigmodel.cn/api/anthropic",
      model: process.env.GLM_ANTHROPIC_MODEL || "glm-4",
    },
    {
      name: "MiniMax",
      apiKey: process.env.MINIMAX_API_KEY,
      baseUrl:
        process.env.MINIMAX_ANTHROPIC_BASE_URL ||
        "https://api.minimaxi.com/anthropic",
      model: process.env.MINIMAX_ANTHROPIC_MODEL || "MiniMax-M2.7-highspeed",
    },
    {
      name: "Kimi",
      apiKey: process.env.KIMI_API_KEY || "",
      baseUrl:
        process.env.KIMI_ANTHROPIC_BASE_URL ||
        "https://api.moonshot.cn/anthropic",
      model: process.env.KIMI_ANTHROPIC_MODEL || "kimi-k2.5",
    },
  ]
).catch((error) => {
  console.error("Test runner failed:", error);
  process.exit(1);
});
