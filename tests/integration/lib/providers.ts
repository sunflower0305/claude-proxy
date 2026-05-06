import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

if (existsSync(".env")) loadEnvFile(".env");

export type ProviderKey =
  | "deepseek"
  | "qwen"
  | "glm"
  | "minimax"
  | "kimi"
  | "mimo";

export interface ProviderDefinition {
  key: ProviderKey;
  name: string;
  apiKey?: string;
  apiKeyEnv: string[];
  baseUrl: string;
  model: string;
}

function pickEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function getProviderDefinitions(): ProviderDefinition[] {
  return [
    {
      key: "deepseek",
      name: "DeepSeek",
      apiKeyEnv: ["DEEPSEEK_API_KEY"],
      apiKey: pickEnv("DEEPSEEK_API_KEY"),
      baseUrl:
        pickEnv("DEEPSEEK_ANTHROPIC_BASE_URL") ||
        "https://api.deepseek.com/anthropic",
      model: pickEnv("DEEPSEEK_MODEL") || "deepseek-v4-pro",
    },
    {
      key: "qwen",
      name: "Qwen",
      apiKeyEnv: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
      apiKey: pickEnv("QWEN_API_KEY", "DASHSCOPE_API_KEY"),
      baseUrl:
        pickEnv("QWEN_ANTHROPIC_BASE_URL") ||
        "https://dashscope.aliyuncs.com/apps/anthropic",
      model: pickEnv("QWEN_MODEL") || "qwen-plus",
    },
    {
      key: "glm",
      name: "GLM",
      apiKeyEnv: ["GLM_API_KEY"],
      apiKey: pickEnv("GLM_API_KEY"),
      baseUrl:
        pickEnv("GLM_ANTHROPIC_BASE_URL") ||
        "https://open.bigmodel.cn/api/anthropic",
      model: pickEnv("GLM_MODEL") || "glm-5",
    },
    {
      key: "minimax",
      name: "MiniMax",
      apiKeyEnv: ["MINIMAX_API_KEY"],
      apiKey: pickEnv("MINIMAX_API_KEY"),
      baseUrl:
        pickEnv("MINIMAX_ANTHROPIC_BASE_URL") ||
        "https://api.minimaxi.com/anthropic",
      model: pickEnv("MINIMAX_MODEL") || "MiniMax-M2.7-highspeed",
    },
    {
      key: "kimi",
      name: "Kimi",
      apiKeyEnv: ["KIMI_API_KEY"],
      apiKey: pickEnv("KIMI_API_KEY"),
      baseUrl:
        pickEnv("KIMI_ANTHROPIC_BASE_URL") ||
        "https://api.moonshot.cn/anthropic",
      model: pickEnv("KIMI_MODEL") || "kimi-k2.5",
    },
    {
      key: "mimo",
      name: "MIMO",
      apiKeyEnv: ["MIMO_API_KEY"],
      apiKey: pickEnv("MIMO_API_KEY"),
      baseUrl:
        pickEnv("MIMO_ANTHROPIC_BASE_URL") ||
        "https://api.xiaomimimo.com/anthropic",
      model: pickEnv("MIMO_MODEL") || "mimo-v2.5-pro",
    },
  ];
}
