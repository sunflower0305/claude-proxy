import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";

export interface RecordedRequest {
  headers: IncomingMessage["headers"];
  body: any;
}

export interface TestHarness {
  proxyBaseUrl: string;
  upstreamPort: number;
  recordedRequests: RecordedRequest[];
  requestPayload: Record<string, unknown>;
  ssePayload: string;
  close(): Promise<void>;
}

export interface ForwardedRequestExpectation {
  expectedModel: string;
  metadata: Record<string, unknown>;
  anthropicVersion?: string;
  anthropicBeta?: string;
  accept?: string;
  stream?: boolean;
}

export const upstreamApiKey = "provider-secret";
export const upstreamModel = "deepseek-chat-native";
export const qwenUpstreamModel = "qwen-plus-native";
export const glmUpstreamModel = "glm-5-native";
export const kimiUpstreamModel = "kimi-k2.5-native";
export const minimaxUpstreamModel = "minimax-m2-native";
export const mimoUpstreamModel = "mimo-v2.5-pro-native";
export const providerCases = [
  { provider: "deepseek", expectedModel: upstreamModel },
  { provider: "qwen", expectedModel: qwenUpstreamModel },
  { provider: "glm", expectedModel: glmUpstreamModel },
  { provider: "minimax", expectedModel: minimaxUpstreamModel },
  { provider: "kimi", expectedModel: kimiUpstreamModel },
  { provider: "mimo", expectedModel: mimoUpstreamModel },
] as const;
export const streamingProviderCases = providerCases.filter(
  ({ provider }) => provider === "deepseek" || provider === "kimi",
);
export const claudeAliasModels = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "opus",
  "sonnet",
  "haiku",
] as const;
export const providerInferenceCases = [
  {
    model: "kimi-k2.5",
    expectedProvider: "kimi",
    expectedModel: kimiUpstreamModel,
  },
  {
    model: "minimax-m2",
    expectedProvider: "minimax",
    expectedModel: minimaxUpstreamModel,
  },
  {
    model: "mimo-v2.5-pro",
    expectedProvider: "mimo",
    expectedModel: mimoUpstreamModel,
  },
] as const;
export const availableProviders = providerCases.map(({ provider }) => provider);
export const testEnvKeys = [
  "PROVIDER",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_ANTHROPIC_BASE_URL",
  "QWEN_API_KEY",
  "QWEN_MODEL",
  "QWEN_ANTHROPIC_BASE_URL",
  "GLM_API_KEY",
  "GLM_MODEL",
  "GLM_ANTHROPIC_BASE_URL",
  "MINIMAX_API_KEY",
  "MINIMAX_MODEL",
  "MINIMAX_ANTHROPIC_BASE_URL",
  "KIMI_API_KEY",
  "KIMI_MODEL",
  "KIMI_ANTHROPIC_BASE_URL",
  "MIMO_API_KEY",
  "MIMO_MODEL",
  "MIMO_ANTHROPIC_BASE_URL",
  "PROXY_PORT",
  "PROXY_API_KEY",
  "CLAUDE_PROXY_LOG",
  "CLAUDE_PROXY_LOG_DIR",
  "CLAUDE_PROXY_REDACT",
] as const;

export type ProviderCase = (typeof providerCases)[number];
export type TestEnvKey = (typeof testEnvKeys)[number];
export type EnvOverrides = Partial<Record<TestEnvKey, string | undefined>>;
export type CreateApp = () => { listen(port: number, hostname: string): Server };

function createSsePayload() {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"deepseek-chat-native","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
}

export function buildRequestPayload() {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 128,
    system: [{ type: "text", text: "You are a helpful assistant." }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Reply with exactly OK." }],
      },
    ],
    tools: [
      {
        name: "echo",
        description: "Echo input",
        input_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
    tool_choice: { type: "auto" },
    thinking: { type: "enabled", budget_tokens: 32 },
    metadata: { case: "success", trace_id: "trace-1" },
  };
}

export async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function startServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine listening port"));
        return;
      }
      resolve(address.port);
    });
  });
}

export function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startTestProxyServer(createApp: CreateApp) {
  const proxy = createApp().listen(0, "127.0.0.1");
  await once(proxy, "listening");

  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("Failed to determine proxy port");
  }

  return {
    proxy,
    proxyBaseUrl: `http://127.0.0.1:${proxyAddress.port}`,
  };
}

export function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers?: Record<string, string>,
) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }
  res.end(JSON.stringify(payload));
}

export function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

export function getLastRecordedRequest(harness: TestHarness): RecordedRequest {
  const forwardedRequest = harness.recordedRequests.at(-1);
  expect(forwardedRequest).toBeTruthy();
  return forwardedRequest!;
}

export function expectProviderState(
  payload: unknown,
  provider: ProviderCase["provider"],
  expectedModel: string,
  upstreamPort: number,
) {
  expect(payload).toEqual({
    provider,
    model: expectedModel,
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    availableProviders,
  });
}

export function expectForwardedRequest(
  harness: TestHarness,
  expectation: ForwardedRequestExpectation,
) {
  const forwardedRequest = getLastRecordedRequest(harness);

  expect(forwardedRequest.headers["x-api-key"]).toBe(upstreamApiKey);
  expect(forwardedRequest.headers["anthropic-version"]).toBe(
    expectation.anthropicVersion ?? "2023-06-01",
  );
  expect(forwardedRequest.headers.accept).toBe(expectation.accept ?? "*/*");
  if (expectation.anthropicBeta) {
    expect(forwardedRequest.headers["anthropic-beta"]).toBe(expectation.anthropicBeta);
  } else {
    expect(forwardedRequest.headers["anthropic-beta"]).toBeUndefined();
  }

  expect(forwardedRequest.body.model).toBe(expectation.expectedModel);
  expect(forwardedRequest.body.system).toEqual(harness.requestPayload.system);
  expect(forwardedRequest.body.messages).toEqual(harness.requestPayload.messages);
  expect(forwardedRequest.body.tools).toEqual(harness.requestPayload.tools);
  expect(forwardedRequest.body.tool_choice).toEqual(harness.requestPayload.tool_choice);
  expect(forwardedRequest.body.thinking).toEqual(harness.requestPayload.thinking);
  expect(forwardedRequest.body.metadata).toEqual(expectation.metadata);
  if (expectation.stream) {
    expect(forwardedRequest.body.stream).toBe(true);
  }
  expect("extra_body" in forwardedRequest.body).toBe(false);
  expect("thinking_budget" in forwardedRequest.body).toBe(false);
  expect("reasoning_split" in forwardedRequest.body).toBe(false);
}

export async function createHarness(envOverrides: EnvOverrides = {}): Promise<TestHarness> {
  const recordedRequests: RecordedRequest[] = [];
  const ssePayload = createSsePayload();
  const upstream = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      writeJson(res, 404, {
        type: "error",
        error: { type: "not_found_error", message: "missing" },
      });
      return;
    }

    const body = await readJsonBody(req);
    recordedRequests.push({ headers: req.headers, body });

    if (body?.metadata?.case === "error") {
      writeJson(res, 422, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "upstream rejected request",
        },
      });
      return;
    }

    if (body?.metadata?.case === "stream-no-body") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (body?.metadata?.case === "stream-chunks") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.write("event: message_start\n");
      res.write('data: {"type":"message_start"}\n\n');
      setImmediate(() => {
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
      return;
    }

    if (body?.metadata?.case === "stream-error-after-headers") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setImmediate(() => {
        res.destroy(new Error("upstream stream failure"));
      });
      return;
    }

    if (body?.metadata?.case === "stream-delay-headers") {
      setTimeout(() => {
        if (res.destroyed) return;
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }, 100);
      return;
    }

    if (body?.metadata?.case === "stream-hold-open") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      return;
    }

    if (body?.stream) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.end(ssePayload);
      return;
    }

    writeJson(
      res,
      200,
      {
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        metadata_echo: body.metadata,
      },
      { "x-upstream-id": "mock-upstream" },
    );
  });
  const upstreamPort = await startServer(upstream);

  const envBackup = Object.fromEntries(testEnvKeys.map((key) => [key, process.env[key]])) as Record<
    TestEnvKey,
    string | undefined
  >;

  const envValues: Record<TestEnvKey, string | undefined> = {
    PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: upstreamApiKey,
    DEEPSEEK_MODEL: upstreamModel,
    DEEPSEEK_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    QWEN_API_KEY: upstreamApiKey,
    QWEN_MODEL: qwenUpstreamModel,
    QWEN_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    GLM_API_KEY: upstreamApiKey,
    GLM_MODEL: glmUpstreamModel,
    GLM_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    MINIMAX_API_KEY: upstreamApiKey,
    MINIMAX_MODEL: minimaxUpstreamModel,
    MINIMAX_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    KIMI_API_KEY: upstreamApiKey,
    KIMI_MODEL: kimiUpstreamModel,
    KIMI_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    MIMO_API_KEY: upstreamApiKey,
    MIMO_MODEL: mimoUpstreamModel,
    MIMO_ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    PROXY_PORT: undefined,
    PROXY_API_KEY: undefined,
    CLAUDE_PROXY_LOG: undefined,
    CLAUDE_PROXY_LOG_DIR: undefined,
    CLAUDE_PROXY_REDACT: undefined,
    ...envOverrides,
  };

  // Empty strings keep local .env files from refilling variables that a test
  // intentionally models as absent; pickEnv treats trimmed empty strings as missing.
  for (const key of testEnvKeys) {
    setEnv(key, envValues[key] ?? "");
  }

  vi.resetModules();
  const { createApp } = await import("../../../src/proxy.ts");
  const { proxy, proxyBaseUrl } = await startTestProxyServer(createApp);

  return {
    proxyBaseUrl,
    upstreamPort,
    recordedRequests,
    requestPayload: buildRequestPayload(),
    ssePayload,
    async close() {
      await closeServer(proxy);
      await closeServer(upstream);
      for (const key of testEnvKeys) {
        setEnv(key, envBackup[key]);
      }
      vi.resetModules();
    },
  };
}

export async function switchProvider(
  baseUrl: string,
  provider: string,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/api/provider`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ provider }),
  });
}

export async function switchProviderByModel(baseUrl: string, model: string) {
  return fetch(`${baseUrl}/api/provider`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ model }),
  });
}

export async function postMessages(
  harness: TestHarness,
  bodyOverrides: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${harness.proxyBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "client-placeholder",
      ...headers,
    },
    body: JSON.stringify({
      ...harness.requestPayload,
      ...bodyOverrides,
    }),
  });
}

export function sendRawPost(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-length": Buffer.byteLength(body).toString(),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    request.end(body);
  });
}

export function abortStreamingPostAfterFirstChunk(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let status = 0;
    const chunks: Buffer[] = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        text: Buffer.concat(chunks).toString("utf8"),
      });
    };
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-length": Buffer.byteLength(body).toString(),
          ...headers,
        },
      },
      (response) => {
        status = response.statusCode ?? 0;
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          response.destroy();
          request.destroy();
        });
        response.on("close", finish);
        response.on("error", finish);
      },
    );

    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") {
        finish();
        return;
      }
      reject(error);
    });
    request.end(body);
  });
}

export function abortPostBeforeResponse(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-length": Buffer.byteLength(body).toString(),
          ...headers,
        },
      },
      (response) => {
        response.resume();
        response.on("close", finish);
      },
    );

    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") {
        finish();
        return;
      }
      reject(error);
    });
    request.end(body, () => {
      setTimeout(() => request.destroy(), 10);
    });
    setTimeout(finish, 200);
  });
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function listCaptureEntries(root: string): Promise<any[]> {
  let sessionDirs: string[];
  try {
    const dirents = await readdir(root, { withFileTypes: true });
    sessionDirs = dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const entries: any[] = [];
  for (const session of sessionDirs.sort()) {
    const sessionDir = path.join(root, session);
    const files = (await readdir(sessionDir)).filter((file) => file.endsWith(".json")).sort();
    for (const file of files) {
      const raw = await readFile(path.join(sessionDir, file), "utf8");
      entries.push(JSON.parse(raw));
    }
  }

  return entries;
}
