/**
 * Claude API Proxy
 *
 * Proxies Anthropic Messages API requests to provider-native
 * Anthropic-compatible endpoints without translating protocols.
 *
 * Usage:
 *   export ANTHROPIC_BASE_URL=http://localhost:8080
 *   export ANTHROPIC_API_KEY=any-key-works
 */

import "dotenv/config";
import cors from "cors";
import express from "express";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  name: string;
  supportsAnthropicMessages: boolean;
  anthropicMessagesError?: string;
}

function pickEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }

  return undefined;
}

const PROVIDERS = {
  deepseek: {
    baseUrl:
      pickEnv("DEEPSEEK_ANTHROPIC_BASE_URL") ||
      "https://api.deepseek.com/anthropic",
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    model: pickEnv("DEEPSEEK_ANTHROPIC_MODEL") || "deepseek-chat",
    name: "DeepSeek",
    supportsAnthropicMessages: true,
  },
  "deepseek-dashscope": {
    baseUrl:
      pickEnv(
        "DEEPSEEK_DASHSCOPE_ANTHROPIC_BASE_URL",
        "DASHSCOPE_ANTHROPIC_BASE_URL"
      ) || "https://dashscope.aliyuncs.com/apps/anthropic",
    apiKey: process.env.DASHSCOPE_API_KEY || "",
    model:
      pickEnv(
        "DEEPSEEK_DASHSCOPE_ANTHROPIC_MODEL",
        "DASHSCOPE_DEEPSEEK_MODEL",
        "DASHSCOPE_ANTHROPIC_MODEL"
      ) || "deepseek-v3.2",
    name: "DeepSeek (DashScope)",
    supportsAnthropicMessages: false,
    anthropicMessagesError:
      "DashScope DeepSeek does not support Anthropic /v1/messages",
  },
  qwen: {
    baseUrl:
      pickEnv("QWEN_ANTHROPIC_BASE_URL", "DASHSCOPE_ANTHROPIC_BASE_URL") ||
      "https://dashscope.aliyuncs.com/apps/anthropic",
    apiKey: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || "",
    model:
      pickEnv("QWEN_ANTHROPIC_MODEL", "DASHSCOPE_ANTHROPIC_MODEL") ||
      "qwen3.6-plus",
    name: "Qwen / 通义千问",
    supportsAnthropicMessages: true,
  },
  "qwen-plus": {
    baseUrl:
      pickEnv(
        "QWEN_PLUS_ANTHROPIC_BASE_URL",
        "QWEN_ANTHROPIC_BASE_URL",
        "DASHSCOPE_ANTHROPIC_BASE_URL"
      ) || "https://dashscope.aliyuncs.com/apps/anthropic",
    apiKey: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || "",
    model:
      pickEnv(
        "QWEN_PLUS_ANTHROPIC_MODEL",
        "QWEN_ANTHROPIC_MODEL",
        "DASHSCOPE_ANTHROPIC_MODEL"
      ) || "qwen3-plus",
    name: "Qwen Plus (Fast)",
    supportsAnthropicMessages: true,
  },
  glm: {
    baseUrl:
      pickEnv("GLM_ANTHROPIC_BASE_URL") ||
      "https://open.bigmodel.cn/api/anthropic",
    apiKey: process.env.GLM_API_KEY || "",
    model: pickEnv("GLM_ANTHROPIC_MODEL") || "glm-4",
    name: "GLM / 智谱",
    supportsAnthropicMessages: true,
  },
  minimax: {
    baseUrl:
      pickEnv("MINIMAX_ANTHROPIC_BASE_URL") ||
      "https://api.minimaxi.com/anthropic",
    apiKey: process.env.MINIMAX_API_KEY || "",
    model: pickEnv("MINIMAX_ANTHROPIC_MODEL") || "MiniMax-M2.7-highspeed",
    name: "MiniMax",
    supportsAnthropicMessages: true,
  },
} satisfies Record<string, ProviderConfig>;

type ProviderKey = keyof typeof PROVIDERS;

function isProviderKey(value: string | undefined): value is ProviderKey {
  return Boolean(value && value in PROVIDERS);
}

let currentProvider: ProviderKey = isProviderKey(process.env.PROVIDER)
  ? process.env.PROVIDER
  : "qwen";

function getConfig(provider: ProviderKey = currentProvider): ProviderConfig {
  return PROVIDERS[provider] || PROVIDERS.qwen;
}

const initialConfig = getConfig();
if (!initialConfig.apiKey) {
  console.warn(`Warning: API key not configured for provider: ${currentProvider}`);
  console.warn("Please set the appropriate environment variable in .env");
}
if (!initialConfig.supportsAnthropicMessages) {
  console.warn(
    `Warning: ${initialConfig.anthropicMessagesError || `${initialConfig.name} does not support Anthropic /v1/messages`}`
  );
}

console.log(`Using ${initialConfig.name} as backend`);
console.log(`Model: ${initialConfig.model}`);

function getTargetModel(requestedModel: unknown): string {
  if (typeof requestedModel !== "string" || !requestedModel) {
    return getConfig().model;
  }

  const normalizedModel = requestedModel.toLowerCase();
  if (
    normalizedModel === "opus" ||
    normalizedModel === "sonnet" ||
    normalizedModel === "haiku"
  ) {
    return getConfig().model;
  }

  if (
    normalizedModel.startsWith("claude-") &&
    (normalizedModel.includes("-opus") ||
      normalizedModel.includes("-sonnet") ||
      normalizedModel.includes("-haiku"))
  ) {
    return getConfig().model;
  }

  return requestedModel;
}

function getHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function buildUpstreamHeaders(
  req: express.Request,
  stream: boolean,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version":
      getHeaderValue(req.headers["anthropic-version"]) ||
      DEFAULT_ANTHROPIC_VERSION,
    accept:
      getHeaderValue(req.headers.accept) ||
      (stream ? "text/event-stream" : "application/json"),
  };

  const anthropicBeta = getHeaderValue(req.headers["anthropic-beta"]);
  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta;
  }

  return headers;
}

function getUpstreamUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/v1/messages`;
}

function buildUpstreamBody(body: unknown, targetModel: string): Record<string, unknown> {
  const normalized =
    typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>) } : {};
  normalized.model = targetModel;
  return normalized;
}

function copyUpstreamHeaders(
  upstream: Response,
  res: express.Response
) {
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    res.setHeader(key, value);
  }
}

function createProxyError(message: string) {
  return {
    type: "error",
    error: {
      type: "internal_error",
      message,
    },
  };
}

function getAnthropicUnsupportedError(config: ProviderConfig) {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        config.anthropicMessagesError ||
        `${config.name} does not support Anthropic /v1/messages`,
    },
  };
}

function ensureAnthropicMessagesSupported(
  res: express.Response,
  provider: ProviderConfig
): boolean {
  if (provider.supportsAnthropicMessages) return true;

  res.status(400).json(getAnthropicUnsupportedError(provider));
  return false;
}

async function handleNonStreamingRequest(
  req: express.Request,
  res: express.Response
) {
  const config = getConfig();
  if (!ensureAnthropicMessagesSupported(res, config)) return;

  const targetModel = getTargetModel(req.body?.model);
  const requestBody = buildUpstreamBody(req.body, targetModel);

  console.log(`\n[${new Date().toISOString()}] ${String(req.body?.model || config.model)} -> ${targetModel} (non-streaming)`);

  try {
    const upstream = await fetch(getUpstreamUrl(config.baseUrl), {
      method: "POST",
      headers: buildUpstreamHeaders(req, false, config.apiKey),
      body: JSON.stringify(requestBody),
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    copyUpstreamHeaders(upstream, res);
    res.status(upstream.status).send(payload);
  } catch (error: any) {
    console.error("Request error:", error);
    res.status(500).json(createProxyError(error.message));
  }
}

async function handleStreamingRequest(
  req: express.Request,
  res: express.Response
) {
  const config = getConfig();
  if (!ensureAnthropicMessagesSupported(res, config)) return;

  const targetModel = getTargetModel(req.body?.model);
  const requestBody = buildUpstreamBody(req.body, targetModel);
  const abortController = new AbortController();
  let clientClosed = false;
  let streamCompleted = false;

  console.log(`\n[${new Date().toISOString()}] ${String(req.body?.model || config.model)} -> ${targetModel} (streaming)`);

  res.on("close", () => {
    if (streamCompleted) return;
    clientClosed = true;
    abortController.abort();
  });

  try {
    const upstream = await fetch(getUpstreamUrl(config.baseUrl), {
      method: "POST",
      headers: buildUpstreamHeaders(req, true, config.apiKey),
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    copyUpstreamHeaders(upstream, res);
    res.status(upstream.status);

    if (!upstream.body) {
      streamCompleted = true;
      res.end();
      return;
    }

    const upstreamStream = Readable.fromWeb(upstream.body as any);
    upstreamStream.on("error", (error) => {
      if (clientClosed) return;
      console.error("Upstream stream error:", error);
      if (!res.writableEnded) res.end();
    });

    upstreamStream.pipe(res);

    await new Promise<void>((resolve, reject) => {
      upstreamStream.on("end", () => {
        streamCompleted = true;
        resolve();
      });
      upstreamStream.on("error", reject);
      res.on("close", () => resolve());
    });
  } catch (error: any) {
    const wasAborted =
      error?.name === "AbortError" || abortController.signal.aborted;

    if (clientClosed || wasAborted) {
      console.warn("[Proxy] Client disconnected, streaming aborted");
      return;
    }

    console.error("Request error:", error);
    if (!res.headersSent) {
      res.status(500).json(createProxyError(error.message));
      return;
    }

    if (!res.writableEnded) res.end();
  }
}

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  app.get("/", (_req, res) => {
    const config = getConfig();
    res.json({
      name: "claude-proxy",
      status: "running",
      provider: currentProvider,
      model: config.model,
      endpoints: {
        messages: "POST /v1/messages",
        health: "GET /health",
        models: "GET /v1/models",
        provider: "GET|POST /api/provider",
      },
    });
  });

  app.post("/v1/messages", async (req, res) => {
    if (req.body?.stream) {
      await handleStreamingRequest(req, res);
      return;
    }

    await handleNonStreamingRequest(req, res);
  });

  app.get("/health", (_req, res) => {
    const config = getConfig();
    res.json({ status: "ok", provider: currentProvider, model: config.model });
  });

  app.get("/v1/models", (_req, res) => {
    res.json({
      data: [
        { id: "claude-opus-4-5-20251101", object: "model" },
        { id: "claude-sonnet-4-20250514", object: "model" },
        { id: "claude-3-5-sonnet-20241022", object: "model" },
      ],
    });
  });

  app.get("/api/provider", (_req, res) => {
    const config = getConfig();
    res.json({
      provider: currentProvider,
      model: config.model,
      name: config.name,
      baseUrl: config.baseUrl,
      availableProviders: Object.keys(PROVIDERS),
    });
  });

  app.post("/api/provider", (req, res) => {
    const { provider, model } = (req.body ?? {}) as {
      provider?: string;
      model?: string;
    };

    let targetProvider = provider;
    if (!targetProvider && model) {
      const normalizedModel = model.toLowerCase();
      if (normalizedModel.includes("qwen")) targetProvider = "qwen";
      else if (normalizedModel.includes("deepseek")) targetProvider = "deepseek";
      else if (normalizedModel.includes("glm")) targetProvider = "glm";
      else if (normalizedModel.includes("minimax") || normalizedModel.includes("abab")) {
        targetProvider = "minimax";
      }
    }

    if (!isProviderKey(targetProvider)) {
      res.status(400).json({
        error: `Unknown provider: ${targetProvider}`,
        available: Object.keys(PROVIDERS),
      });
      return;
    }

    const targetConfig = getConfig(targetProvider);

    if (!targetConfig.supportsAnthropicMessages) {
      res.status(400).json({
        error:
          targetConfig.anthropicMessagesError ||
          `Provider ${targetProvider} does not support Anthropic /v1/messages`,
      });
      return;
    }

    if (!targetConfig.apiKey) {
      res.status(400).json({
        error: `API key not set for: ${targetProvider}`,
      });
      return;
    }

    const oldProvider = currentProvider;
    currentProvider = targetProvider;
    console.log(`Provider: ${oldProvider} -> ${currentProvider}`);

    res.json({
      success: true,
      provider: currentProvider,
      model: targetConfig.model,
      name: targetConfig.name,
    });
  });

  return app;
}

export const app = createApp();

const PORT = parseInt(process.env.PROXY_PORT || "8080", 10);

function isMainModule() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  app.listen(PORT, () => {
    const cfg = getConfig();
    console.log(`
╔════════════════════════════════════════════════╗
║         claude-proxy                           ║
╠════════════════════════════════════════════════╣
║  http://localhost:${PORT}
║  Backend: ${cfg.name} (${cfg.model})
╠════════════════════════════════════════════════╣
║  Set these env vars in your app:               ║
║  ANTHROPIC_BASE_URL=http://localhost:${PORT}
║  ANTHROPIC_API_KEY=any-string-works            ║
╚════════════════════════════════════════════════╝
  `);
  });
}
