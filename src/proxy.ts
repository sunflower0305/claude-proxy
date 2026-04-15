/**
 * Claude Proxy
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
}

interface RequestTrace {
  requestId: string;
  provider: ProviderKey;
  requestedModel: string;
  targetModel: string;
  stream: boolean;
  startedAt: number;
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
    model: pickEnv("DEEPSEEK_MODEL") || "deepseek-chat",
  },
  qwen: {
    baseUrl:
      pickEnv("QWEN_ANTHROPIC_BASE_URL") ||
      "https://dashscope.aliyuncs.com/apps/anthropic",
    apiKey: process.env.QWEN_API_KEY || "",
    model: pickEnv("QWEN_MODEL") || "qwen-plus",
  },
  glm: {
    baseUrl:
      pickEnv("GLM_ANTHROPIC_BASE_URL") ||
      "https://open.bigmodel.cn/api/anthropic",
    apiKey: process.env.GLM_API_KEY || "",
    model: pickEnv("GLM_MODEL") || "glm-5",
  },
  minimax: {
    baseUrl:
      pickEnv("MINIMAX_ANTHROPIC_BASE_URL") ||
      "https://api.minimaxi.com/anthropic",
    apiKey: process.env.MINIMAX_API_KEY || "",
    model: pickEnv("MINIMAX_MODEL") || "MiniMax-M2.7-highspeed",
  },
  kimi: {
    baseUrl:
      pickEnv("KIMI_ANTHROPIC_BASE_URL") || "https://api.moonshot.cn/anthropic",
    apiKey: process.env.KIMI_API_KEY || "",
    model: pickEnv("KIMI_MODEL") || "kimi-k2.5",
  },
} satisfies Record<string, ProviderConfig>;

type ProviderKey = keyof typeof PROVIDERS;

function isProviderKey(value: string | undefined): value is ProviderKey {
  return Boolean(value && value in PROVIDERS);
}

let currentProvider: ProviderKey = isProviderKey(process.env.PROVIDER)
  ? process.env.PROVIDER
  : "qwen";
let requestSequence = 0;

function getConfig(provider: ProviderKey = currentProvider): ProviderConfig {
  return PROVIDERS[provider] || PROVIDERS.qwen;
}

const initialConfig = getConfig();
if (!initialConfig.apiKey) {
  console.warn(
    `Warning: API key not configured for provider: ${currentProvider}`
  );
  console.warn("Please set the appropriate environment variable in .env");
}

console.log(`Using ${currentProvider} as backend`);
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

function buildUpstreamBody(
  body: unknown,
  targetModel: string
): Record<string, unknown> {
  const normalized =
    typeof body === "object" && body !== null
      ? { ...(body as Record<string, unknown>) }
      : {};
  normalized.model = targetModel;
  return normalized;
}

function copyUpstreamHeaders(upstream: Response, res: express.Response) {
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

function createRequestTrace(
  requestedModel: unknown,
  targetModel: string,
  stream: boolean
): RequestTrace {
  return {
    requestId: `req-${++requestSequence}`,
    provider: currentProvider,
    requestedModel: String(requestedModel || getConfig().model),
    targetModel,
    stream,
    startedAt: Date.now(),
  };
}

function logTimingEvent(
  trace: RequestTrace,
  phase:
    | "start"
    | "upstream_headers"
    | "first_chunk"
    | "completed"
    | "client_aborted"
    | "error",
  extra: Record<string, unknown> = {}
) {
  console.log(
    `[ProxyTiming] ${JSON.stringify({
      request_id: trace.requestId,
      provider: trace.provider,
      requested_model: trace.requestedModel,
      target_model: trace.targetModel,
      stream: trace.stream,
      phase,
      elapsed_ms: Date.now() - trace.startedAt,
      at: new Date().toISOString(),
      ...extra,
    })}`
  );
}

async function handleNonStreamingRequest(
  req: express.Request,
  res: express.Response
) {
  const config = getConfig();

  const targetModel = getTargetModel(req.body?.model);
  const requestBody = buildUpstreamBody(req.body, targetModel);
  const trace = createRequestTrace(req.body?.model, targetModel, false);

  console.log(
    `\n[${new Date().toISOString()}] ${String(req.body?.model || config.model)} -> ${targetModel} (non-streaming)`
  );
  logTimingEvent(trace, "start");

  try {
    const upstream = await fetch(getUpstreamUrl(config.baseUrl), {
      method: "POST",
      headers: buildUpstreamHeaders(req, false, config.apiKey),
      body: JSON.stringify(requestBody),
    });
    logTimingEvent(trace, "upstream_headers", {
      status: upstream.status,
      content_type: upstream.headers.get("content-type") || "",
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    copyUpstreamHeaders(upstream, res);
    res.status(upstream.status).send(payload);
    logTimingEvent(trace, "completed", {
      status: upstream.status,
      bytes: payload.byteLength,
    });
  } catch (error: any) {
    console.error("Request error:", error);
    logTimingEvent(trace, "error", { message: error?.message || String(error) });
    res.status(500).json(createProxyError(error.message));
  }
}

async function handleStreamingRequest(
  req: express.Request,
  res: express.Response
) {
  const config = getConfig();

  const targetModel = getTargetModel(req.body?.model);
  const requestBody = buildUpstreamBody(req.body, targetModel);
  const trace = createRequestTrace(req.body?.model, targetModel, true);
  const abortController = new AbortController();
  let clientClosed = false;
  let streamCompleted = false;
  let sawFirstChunk = false;

  console.log(
    `\n[${new Date().toISOString()}] ${String(req.body?.model || config.model)} -> ${targetModel} (streaming)`
  );
  logTimingEvent(trace, "start");

  res.on("close", () => {
    if (streamCompleted) return;
    clientClosed = true;
    abortController.abort();
    logTimingEvent(trace, "client_aborted");
  });

  try {
    const upstream = await fetch(getUpstreamUrl(config.baseUrl), {
      method: "POST",
      headers: buildUpstreamHeaders(req, true, config.apiKey),
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });
    logTimingEvent(trace, "upstream_headers", {
      status: upstream.status,
      content_type: upstream.headers.get("content-type") || "",
    });

    copyUpstreamHeaders(upstream, res);
    res.status(upstream.status);

    if (!upstream.body) {
      streamCompleted = true;
      res.end();
      logTimingEvent(trace, "completed", {
        status: upstream.status,
        bytes: 0,
        no_body: true,
      });
      return;
    }

    const upstreamStream = Readable.fromWeb(upstream.body as any);
    upstreamStream.on("data", (chunk) => {
      if (sawFirstChunk) return;
      sawFirstChunk = true;
      const chunkSize = Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : Buffer.byteLength(String(chunk));
      logTimingEvent(trace, "first_chunk", {
        status: upstream.status,
        chunk_bytes: chunkSize,
      });
    });
    upstreamStream.on("error", (error) => {
      if (clientClosed) return;
      console.error("Upstream stream error:", error);
      logTimingEvent(trace, "error", {
        status: upstream.status,
        message: error?.message || String(error),
      });
      if (!res.writableEnded) res.end();
    });

    upstreamStream.pipe(res);

    await new Promise<void>((resolve, reject) => {
      upstreamStream.on("end", () => {
        streamCompleted = true;
        logTimingEvent(trace, "completed", {
          status: upstream.status,
        });
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
    logTimingEvent(trace, "error", { message: error?.message || String(error) });
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
        { id: "claude-opus-4-6", object: "model" },
        { id: "claude-sonnet-4-6", object: "model" },
        { id: "claude-haiku-4-5", object: "model" },
      ],
    });
  });

  app.get("/api/provider", (_req, res) => {
    const config = getConfig();
    res.json({
      provider: currentProvider,
      model: config.model,
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
      if (normalizedModel.includes("kimi")) {
        targetProvider = "kimi";
      } else if (normalizedModel.includes("qwen")) targetProvider = "qwen";
      else if (normalizedModel.includes("deepseek"))
        targetProvider = "deepseek";
      else if (normalizedModel.includes("glm")) targetProvider = "glm";
      else if (normalizedModel.includes("minimax")) {
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
║  Backend: ${currentProvider} (${cfg.model})
╠════════════════════════════════════════════════╣
║  Set these env vars in your app:               ║
║  ANTHROPIC_BASE_URL=http://localhost:${PORT}
║  ANTHROPIC_API_KEY=any-string-works            ║
╚════════════════════════════════════════════════╝
  `);
  });
}
