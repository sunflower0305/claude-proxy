import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import express from "express";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptureStoreFromEnv } from "../../src/capture-store.js";

interface RecordedRequest {
  headers: IncomingMessage["headers"];
  body: any;
}

interface TestHarness {
  proxyBaseUrl: string;
  upstreamPort: number;
  recordedRequests: RecordedRequest[];
  requestPayload: Record<string, unknown>;
  ssePayload: string;
  close(): Promise<void>;
}

interface ForwardedRequestExpectation {
  expectedModel: string;
  metadata: Record<string, unknown>;
  anthropicVersion?: string;
  anthropicBeta?: string;
  accept?: string;
  stream?: boolean;
}

const upstreamApiKey = "provider-secret";
const upstreamModel = "deepseek-chat-native";
const qwenUpstreamModel = "qwen-plus-native";
const glmUpstreamModel = "glm-5-native";
const kimiUpstreamModel = "kimi-k2.5-native";
const minimaxUpstreamModel = "minimax-m2-native";
const mimoUpstreamModel = "mimo-v2.5-pro-native";
const providerCases = [
  { provider: "deepseek", expectedModel: upstreamModel },
  { provider: "qwen", expectedModel: qwenUpstreamModel },
  { provider: "glm", expectedModel: glmUpstreamModel },
  { provider: "minimax", expectedModel: minimaxUpstreamModel },
  { provider: "kimi", expectedModel: kimiUpstreamModel },
  { provider: "mimo", expectedModel: mimoUpstreamModel },
] as const;
const streamingProviderCases = providerCases.filter(
  ({ provider }) => provider === "deepseek" || provider === "kimi",
);
const claudeAliasModels = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "opus",
  "sonnet",
  "haiku",
] as const;
const providerInferenceCases = [
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
const availableProviders = providerCases.map(({ provider }) => provider);
const testEnvKeys = [
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

type ProviderCase = (typeof providerCases)[number];
type TestEnvKey = (typeof testEnvKeys)[number];
type EnvOverrides = Partial<Record<TestEnvKey, string | undefined>>;
type CreateApp = () => { listen(port: number, hostname: string): Server };

function createSsePayload() {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"deepseek-chat-native","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
}

function buildRequestPayload() {
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

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function startServer(server: Server): Promise<number> {
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

function closeServer(server: Server) {
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

async function startTestProxyServer(createApp: CreateApp) {
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

function writeJson(
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

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function getLastRecordedRequest(harness: TestHarness): RecordedRequest {
  const forwardedRequest = harness.recordedRequests.at(-1);
  expect(forwardedRequest).toBeTruthy();
  return forwardedRequest!;
}

function expectProviderState(
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

function expectForwardedRequest(harness: TestHarness, expectation: ForwardedRequestExpectation) {
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

async function createHarness(envOverrides: EnvOverrides = {}): Promise<TestHarness> {
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
  const { createApp } = await import("../../src/proxy.ts");
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

async function switchProvider(
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

async function switchProviderByModel(baseUrl: string, model: string) {
  return fetch(`${baseUrl}/api/provider`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ model }),
  });
}

async function postMessages(
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

function sendRawPost(
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

function abortStreamingPostAfterFirstChunk(
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

function abortPostBeforeResponse(
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function listCaptureEntries(root: string): Promise<any[]> {
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

describe.sequential("proxy local integration", () => {
  let harness: TestHarness;
  let cleanupHarness: TestHarness | undefined;

  beforeEach(async () => {
    harness = await createHarness();
    cleanupHarness = harness;
  });

  afterEach(async () => {
    if (!cleanupHarness) return;
    await cleanupHarness.close();
    cleanupHarness = undefined;
  });

  it("reports proxy metadata from the root endpoint", async () => {
    const response = await fetch(`${harness.proxyBaseUrl}/`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "claude-proxy",
      status: "running",
      provider: "deepseek",
      model: upstreamModel,
      endpoints: {
        messages: "POST /v1/messages",
        health: "GET /health",
        models: "GET /v1/models",
        provider: "GET|POST /api/provider",
      },
    });
  });

  it("does not enable CORS for browser origins by default", async () => {
    const response = await fetch(`${harness.proxyBaseUrl}/health`, {
      headers: { origin: "https://example.com" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps message proxy auth disabled when PROXY_API_KEY is not set", async () => {
    const response = await postMessages(
      harness,
      { metadata: { case: "success", trace_id: "auth-disabled" } },
      { "x-api-key": "any-client-token" },
    );

    expect(response.status).toBe(200);
    expect(harness.recordedRequests).toHaveLength(1);
  });

  it("keeps capture logging disabled by default even when a log dir is configured", async () => {
    await cleanupHarness?.close();
    const captureRoot = await mkdtemp(path.join(tmpdir(), "claude-proxy-capture-"));
    harness = await createHarness({ CLAUDE_PROXY_LOG_DIR: captureRoot });
    cleanupHarness = harness;

    try {
      const response = await postMessages(harness, {
        metadata: { case: "success", trace_id: "capture-disabled" },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ model: upstreamModel });
      await expect(listCaptureEntries(captureRoot)).resolves.toEqual([]);
    } finally {
      await rm(captureRoot, { recursive: true, force: true });
    }
  });

  it("writes one final capture only after the session settles", async () => {
    const captureRoot = await mkdtemp(path.join(tmpdir(), "claude-proxy-capture-"));
    const store = createCaptureStoreFromEnv({
      CLAUDE_PROXY_LOG: "1",
      CLAUDE_PROXY_LOG_DIR: captureRoot,
    });

    try {
      const session = store.begin({
        provider: "deepseek",
        requestedModel: "claude-sonnet-4-6",
        targetModel: upstreamModel,
        stream: false,
        request: {
          method: "POST",
          url: "/v1/messages",
          headers: {},
          body: { model: "claude-sonnet-4-6" },
        },
      });

      session.setResponse(200, new Headers({ "content-type": "application/json" }));
      session.append('{"ok":true}');
      await expect(listCaptureEntries(captureRoot)).resolves.toEqual([]);

      session.complete();
      session.fail(new Error("ignored after completion"));

      const entries = await listCaptureEntries(captureRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0].response).toMatchObject({
        status: 200,
        raw: '{"ok":true}',
        bytes: 11,
      });
      expect(entries[0].response.error).toBeUndefined();
    } finally {
      await rm(captureRoot, { recursive: true, force: true });
    }
  });

  it("warns without throwing when a final capture cannot be persisted", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createCaptureStoreFromEnv({
      CLAUDE_PROXY_LOG: "1",
      CLAUDE_PROXY_LOG_DIR: path.join("/dev/null", "claude-proxy-capture"),
    });

    try {
      const session = store.begin({
        provider: "deepseek",
        requestedModel: "claude-sonnet-4-6",
        targetModel: upstreamModel,
        stream: false,
        request: {
          method: "POST",
          url: "/v1/messages",
          headers: {},
          body: { model: "claude-sonnet-4-6" },
        },
      });

      expect(() => session.complete()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        "[CaptureStore] Failed to persist capture:",
        expect.stringContaining("not a directory"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to a disabled capture store when initialization fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("node:path", () => ({
      default: {
        resolve: () => {
          throw new Error("resolve failed");
        },
      },
    }));

    try {
      const { createCaptureStoreFromEnv: createStore } = await import("../../src/capture-store.js");
      const store = createStore({
        CLAUDE_PROXY_LOG: "1",
        CLAUDE_PROXY_LOG_DIR: "capture-root",
      });

      expect(() => {
        const session = store.begin({
          provider: "deepseek",
          requestedModel: "claude-sonnet-4-6",
          targetModel: upstreamModel,
          stream: false,
          request: {
            method: "POST",
            url: "/v1/messages",
            headers: {},
            body: { model: "claude-sonnet-4-6" },
          },
        });
        session.setResponse(200, new Headers());
        session.append("ignored");
        session.complete();
      }).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        "[CaptureStore] Failed to initialize capture store:",
        "resolve failed",
      );
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
      warnSpy.mockRestore();
    }
  });

  it("captures non-streaming requests and responses when logging is enabled", async () => {
    await cleanupHarness?.close();
    const captureRoot = await mkdtemp(path.join(tmpdir(), "claude-proxy-capture-"));
    harness = await createHarness({
      CLAUDE_PROXY_LOG: "1",
      CLAUDE_PROXY_LOG_DIR: captureRoot,
    });
    cleanupHarness = harness;

    try {
      const metadata = { case: "success", trace_id: "capture-non-stream" };
      const response = await postMessages(
        harness,
        { metadata },
        {
          authorization: "Bearer client-secret-token",
          "x-api-key": "client-secret-token",
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        model: upstreamModel,
        metadata_echo: metadata,
      });

      await waitFor(async () => (await listCaptureEntries(captureRoot)).length === 1);
      const [entry] = await listCaptureEntries(captureRoot);

      expect(entry).toMatchObject({
        provider: "deepseek",
        requestedModel: "claude-sonnet-4-6",
        targetModel: upstreamModel,
        stream: false,
        request: {
          method: "POST",
          url: "/v1/messages",
          body: expect.objectContaining({
            model: "claude-sonnet-4-6",
            metadata,
          }),
        },
        response: {
          status: 200,
          bytes: expect.any(Number),
        },
      });
      expect(entry.request.headers["x-api-key"]).toBe("[REDACTED]");
      expect(entry.request.headers.authorization).toBe("[REDACTED]");
      expect(entry.response.raw).toContain('"metadata_echo"');
      expect(entry.response.headers["content-type"]).toMatch(/^application\/json/i);
      expect(entry.response.finishedAt).toBeGreaterThanOrEqual(entry.startedAt);
    } finally {
      await rm(captureRoot, { recursive: true, force: true });
    }
  });

  it("captures streamed SSE responses without changing the client body", async () => {
    await cleanupHarness?.close();
    const captureRoot = await mkdtemp(path.join(tmpdir(), "claude-proxy-capture-"));
    harness = await createHarness({
      CLAUDE_PROXY_LOG: "1",
      CLAUDE_PROXY_LOG_DIR: captureRoot,
    });
    cleanupHarness = harness;

    try {
      const metadata = { case: "stream", trace_id: "capture-stream" };
      const response = await postMessages(harness, { stream: true, metadata });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(harness.ssePayload);

      await waitFor(async () => (await listCaptureEntries(captureRoot)).length === 1);
      const [entry] = await listCaptureEntries(captureRoot);

      expect(entry.stream).toBe(true);
      expect(entry.request.body).toMatchObject({
        model: "claude-sonnet-4-6",
        stream: true,
        metadata,
      });
      expect(entry.response.status).toBe(200);
      expect(entry.response.raw).toBe(harness.ssePayload);
      expect(entry.response.bytes).toBe(Buffer.byteLength(harness.ssePayload));
      expect(entry.response.firstByteAt).toBeGreaterThanOrEqual(entry.startedAt);
      expect(entry.response.headers["content-type"]).toMatch(/^text\/event-stream/i);
    } finally {
      await rm(captureRoot, { recursive: true, force: true });
    }
  });

  it("keeps partial streamed capture details when the upstream stream errors", async () => {
    await cleanupHarness?.close();
    const captureRoot = await mkdtemp(path.join(tmpdir(), "claude-proxy-capture-"));
    harness = await createHarness({
      CLAUDE_PROXY_LOG: "1",
      CLAUDE_PROXY_LOG_DIR: captureRoot,
    });
    cleanupHarness = harness;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await postMessages(harness, {
        stream: true,
        metadata: {
          case: "stream-error-after-headers",
          trace_id: "capture-stream-error-after-headers",
        },
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("message_start");

      await waitFor(async () => (await listCaptureEntries(captureRoot)).length === 1);
      const [entry] = await listCaptureEntries(captureRoot);

      expect(entry.response.status).toBe(200);
      expect(entry.response.error).toEqual(expect.any(String));
      expect(entry.response.raw).toContain("message_start");
      expect(entry.response.headers["content-type"]).toMatch(/^text\/event-stream/i);
    } finally {
      errorSpy.mockRestore();
      await rm(captureRoot, { recursive: true, force: true });
    }
  });

  it("captures a partial streamed response when the client disconnects", async () => {
    await cleanupHarness?.close();
    const captureRoot = await mkdtemp(path.join(tmpdir(), "claude-proxy-capture-"));
    harness = await createHarness({
      CLAUDE_PROXY_LOG: "1",
      CLAUDE_PROXY_LOG_DIR: captureRoot,
    });
    cleanupHarness = harness;

    try {
      const body = JSON.stringify({
        ...harness.requestPayload,
        stream: true,
        metadata: {
          case: "stream-hold-open",
          trace_id: "capture-client-abort",
        },
      });

      const response = await abortStreamingPostAfterFirstChunk(
        `${harness.proxyBaseUrl}/v1/messages`,
        body,
        {
          "content-type": "application/json",
          "x-api-key": "client-placeholder",
        },
      );

      expect(response.status).toBe(200);
      expect(response.text).toContain("message_start");
      await waitFor(async () => (await listCaptureEntries(captureRoot)).length === 1);

      const [entry] = await listCaptureEntries(captureRoot);
      expect(entry.response).toMatchObject({
        status: 200,
        aborted: true,
        error: "client aborted",
      });
      expect(entry.response.raw).toContain("message_start");
    } finally {
      await rm(captureRoot, { recursive: true, force: true });
    }
  });

  it("captures upstream error payloads as completed non-stream responses", async () => {
    await cleanupHarness?.close();
    const captureRoot = await mkdtemp(path.join(tmpdir(), "claude-proxy-capture-"));
    harness = await createHarness({
      CLAUDE_PROXY_LOG: "1",
      CLAUDE_PROXY_LOG_DIR: captureRoot,
    });
    cleanupHarness = harness;

    try {
      const response = await postMessages(harness, {
        metadata: { case: "error", trace_id: "capture-upstream-error-payload" },
      });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: "upstream rejected request" },
      });

      await waitFor(async () => (await listCaptureEntries(captureRoot)).length === 1);
      const [entry] = await listCaptureEntries(captureRoot);

      expect(entry.response.status).toBe(422);
      expect(entry.response.error).toBeUndefined();
      expect(entry.response.raw).toContain("invalid_request_error");
    } finally {
      await rm(captureRoot, { recursive: true, force: true });
    }
  });

  it("captures fetch failures as response errors", async () => {
    await cleanupHarness?.close();
    const captureRoot = await mkdtemp(path.join(tmpdir(), "claude-proxy-capture-"));
    harness = await createHarness({
      CLAUDE_PROXY_LOG: "1",
      CLAUDE_PROXY_LOG_DIR: captureRoot,
      DEEPSEEK_ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    });
    cleanupHarness = harness;

    try {
      const response = await postMessages(harness, {
        metadata: { case: "success", trace_id: "capture-fetch-error" },
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        type: "error",
        error: { type: "internal_error" },
      });

      await waitFor(async () => (await listCaptureEntries(captureRoot)).length === 1);
      const [entry] = await listCaptureEntries(captureRoot);

      expect(entry.response.status).toBeUndefined();
      expect(entry.response.error).toEqual(expect.any(String));
      expect(entry.response.finishedAt).toBeGreaterThanOrEqual(entry.startedAt);
    } finally {
      await rm(captureRoot, { recursive: true, force: true });
    }
  });

  it.each<{ label: string; headers: Record<string, string> }>([
    { label: "x-api-key", headers: { "x-api-key": "local-proxy-token" } },
    {
      label: "authorization bearer",
      headers: { authorization: "Bearer local-proxy-token" },
    },
  ])("accepts message requests authorized with $label", async ({ headers }) => {
    await cleanupHarness?.close();
    harness = await createHarness({ PROXY_API_KEY: "local-proxy-token" });
    cleanupHarness = harness;

    const metadata = { case: "success", trace_id: "authorized-message" };
    const response = await postMessages(harness, { metadata }, headers);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: upstreamModel,
      metadata_echo: metadata,
    });
    expect(harness.recordedRequests).toHaveLength(1);
  });

  it.each<{ label: string; headers: Record<string, string> }>([
    { label: "missing", headers: {} },
    { label: "invalid", headers: { "x-api-key": "wrong-token" } },
    { label: "invalid bearer", headers: { authorization: "Basic wrong-token" } },
  ])(
    "rejects message requests with $label proxy token without forwarding upstream",
    async ({ headers }) => {
      await cleanupHarness?.close();
      harness = await createHarness({ PROXY_API_KEY: "local-proxy-token" });
      cleanupHarness = harness;

      const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(harness.requestPayload),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      });
      expect(harness.recordedRequests).toHaveLength(0);
    },
  );

  it("rejects unauthorized provider switches without changing the provider", async () => {
    await cleanupHarness?.close();
    harness = await createHarness({ PROXY_API_KEY: "local-proxy-token" });
    cleanupHarness = harness;

    const response = await switchProvider(harness.proxyBaseUrl, "kimi");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid API key",
      },
    });

    const currentProviderResponse = await fetch(`${harness.proxyBaseUrl}/api/provider`);
    expect(currentProviderResponse.status).toBe(200);
    expectProviderState(
      await currentProviderResponse.json(),
      "deepseek",
      upstreamModel,
      harness.upstreamPort,
    );
  });

  it("accepts provider switches authorized with the proxy token", async () => {
    await cleanupHarness?.close();
    harness = await createHarness({ PROXY_API_KEY: "local-proxy-token" });
    cleanupHarness = harness;

    const response = await switchProvider(harness.proxyBaseUrl, "kimi", {
      "x-api-key": "local-proxy-token",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      provider: "kimi",
      model: kimiUpstreamModel,
    });
  });

  it("leaves health and model listing public when proxy auth is enabled", async () => {
    await cleanupHarness?.close();
    harness = await createHarness({ PROXY_API_KEY: "local-proxy-token" });
    cleanupHarness = harness;

    const [healthResponse, modelsResponse] = await Promise.all([
      fetch(`${harness.proxyBaseUrl}/health`),
      fetch(`${harness.proxyBaseUrl}/v1/models`),
    ]);

    expect(healthResponse.status).toBe(200);
    expect(modelsResponse.status).toBe(200);
  });

  it.each([
    { provider: undefined, label: "missing" },
    { provider: "not-a-provider", label: "invalid" },
  ])("defaults to deepseek when PROVIDER is $label", async ({ provider }) => {
    await cleanupHarness?.close();
    harness = await createHarness({ PROVIDER: provider });
    cleanupHarness = harness;

    const [healthResponse, providerResponse] = await Promise.all([
      fetch(`${harness.proxyBaseUrl}/health`),
      fetch(`${harness.proxyBaseUrl}/api/provider`),
    ]);

    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({
      status: "ok",
      provider: "deepseek",
      model: upstreamModel,
    });

    expect(providerResponse.status).toBe(200);
    expectProviderState(
      await providerResponse.json(),
      "deepseek",
      upstreamModel,
      harness.upstreamPort,
    );
  });

  it("uses deepseek default model and base URL when env overrides are absent", async () => {
    await cleanupHarness?.close();
    harness = await createHarness({
      PROVIDER: undefined,
      DEEPSEEK_MODEL: undefined,
      DEEPSEEK_ANTHROPIC_BASE_URL: undefined,
    });
    cleanupHarness = harness;

    const response = await fetch(`${harness.proxyBaseUrl}/api/provider`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/anthropic",
      availableProviders,
    });
  });

  it("loads .env from the current working directory without overriding existing env", async () => {
    await cleanupHarness?.close();
    cleanupHarness = undefined;

    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "claude-proxy-env-"));
    const envBackup = Object.fromEntries(
      testEnvKeys.map((key) => [key, process.env[key]]),
    ) as Record<TestEnvKey, string | undefined>;
    const recordedRequests: RecordedRequest[] = [];
    let proxy: Server | undefined;
    let upstream: Server | undefined;

    try {
      upstream = http.createServer(async (req, res) => {
        const body = await readJsonBody(req);
        recordedRequests.push({ headers: req.headers, body });
        writeJson(res, 200, {
          id: "msg_upstream",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });
      const upstreamPort = await startServer(upstream);

      for (const key of testEnvKeys) {
        setEnv(key, undefined);
      }
      process.env.DEEPSEEK_API_KEY = "existing-secret";

      await writeFile(
        path.join(tempDir, ".env"),
        [
          "PROVIDER=deepseek",
          "DEEPSEEK_API_KEY=file-secret",
          "DEEPSEEK_MODEL=env-file-model",
          `DEEPSEEK_ANTHROPIC_BASE_URL=http://127.0.0.1:${upstreamPort}`,
          "",
        ].join("\n"),
        "utf8",
      );

      process.chdir(tempDir);
      vi.resetModules();
      const { createApp } = await import("../../src/proxy.ts");
      const startedProxy = await startTestProxyServer(createApp);
      proxy = startedProxy.proxy;

      const providerResponse = await fetch(`${startedProxy.proxyBaseUrl}/api/provider`);
      expect(providerResponse.status).toBe(200);
      await expect(providerResponse.json()).resolves.toEqual({
        provider: "deepseek",
        model: "env-file-model",
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        availableProviders,
      });

      const messageResponse = await fetch(`${startedProxy.proxyBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-placeholder",
        },
        body: JSON.stringify(buildRequestPayload()),
      });

      expect(messageResponse.status).toBe(200);
      expect(recordedRequests.at(-1)?.headers["x-api-key"]).toBe("existing-secret");
    } finally {
      if (proxy) await closeServer(proxy);
      if (upstream) await closeServer(upstream);
      process.chdir(originalCwd);
      for (const key of testEnvKeys) {
        setEnv(key, envBackup[key]);
      }
      await rm(tempDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("imports as a library when the process entrypoint is missing or invalid", async () => {
    await cleanupHarness?.close();
    cleanupHarness = undefined;

    const originalArgv1 = process.argv[1];
    const envBackup = Object.fromEntries(
      testEnvKeys.map((key) => [key, process.env[key]]),
    ) as Record<TestEnvKey, string | undefined>;

    try {
      for (const key of testEnvKeys) {
        setEnv(key, undefined);
      }

      Reflect.deleteProperty(process.argv, "1");
      vi.resetModules();
      await expect(import("../../src/proxy.ts")).resolves.toHaveProperty("createApp");

      process.argv[1] = "/path/that/does/not/exist/claude-proxy.js";
      vi.resetModules();
      await expect(import("../../src/proxy.ts")).resolves.toHaveProperty("createApp");
    } finally {
      if (originalArgv1 === undefined) {
        Reflect.deleteProperty(process.argv, "1");
      } else {
        process.argv[1] = originalArgv1;
      }
      for (const key of testEnvKeys) {
        setEnv(key, envBackup[key]);
      }
      vi.resetModules();
    }
  });

  it.each([
    { proxyApiKey: undefined, clientApiKeyHint: "any-string-works" },
    { proxyApiKey: "local-proxy-token", clientApiKeyHint: "same value as PROXY_API_KEY" },
  ])(
    "starts the CLI server and prints startup guidance when PROXY_API_KEY is $proxyApiKey",
    async ({ proxyApiKey, clientApiKeyHint }) => {
      await cleanupHarness?.close();
      cleanupHarness = undefined;

      const envBackup = Object.fromEntries(
        testEnvKeys.map((key) => [key, process.env[key]]),
      ) as Record<TestEnvKey, string | undefined>;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const listenSpy = vi
        .spyOn(express.application, "listen")
        .mockImplementation((...args: any[]) => {
          const callback = args.find((arg) => typeof arg === "function");
          callback?.();
          return {
            close(closeCallback?: (error?: Error) => void) {
              closeCallback?.();
            },
          } as Server;
        });
      const originalArgv1 = process.argv[1];

      try {
        for (const key of testEnvKeys) {
          setEnv(key, "");
        }
        process.env.PROVIDER = "deepseek";
        process.env.PROXY_PORT = "0";
        setEnv("PROXY_API_KEY", proxyApiKey);
        process.argv[1] = path.resolve("src/proxy.ts");

        vi.resetModules();
        await import("../../src/proxy.ts");

        expect(listenSpy).toHaveBeenCalledWith(0, expect.any(Function));
        expect(warnSpy).toHaveBeenCalledWith(
          "Warning: API key not configured for provider: deepseek",
        );
        expect(warnSpy).toHaveBeenCalledWith(
          "Please set the appropriate environment variable in .env",
        );
        expect(logSpy).toHaveBeenCalledWith("Using deepseek as backend");
        expect(logSpy).toHaveBeenCalledWith("Model: deepseek-v4-pro");
        expect(
          logSpy.mock.calls.some(([message]) => String(message).includes(clientApiKeyHint)),
        ).toBe(true);
      } finally {
        if (originalArgv1 === undefined) {
          Reflect.deleteProperty(process.argv, "1");
        } else {
          process.argv[1] = originalArgv1;
        }
        listenSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
        for (const key of testEnvKeys) {
          setEnv(key, envBackup[key]);
        }
        vi.resetModules();
      }
    },
  );

  it.each(providerCases)(
    "switches provider to $provider successfully",
    async ({ provider, expectedModel }) => {
      const response = await switchProvider(harness.proxyBaseUrl, provider);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        success: true,
        provider,
        model: expectedModel,
      });
    },
  );

  it("rejects switching providers when the target API key is missing", async () => {
    await cleanupHarness?.close();
    harness = await createHarness({ KIMI_API_KEY: undefined });
    cleanupHarness = harness;

    const response = await switchProvider(harness.proxyBaseUrl, "kimi");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "API key not set for: kimi",
    });

    const currentProviderResponse = await fetch(`${harness.proxyBaseUrl}/api/provider`);

    expect(currentProviderResponse.status).toBe(200);
    expectProviderState(
      await currentProviderResponse.json(),
      "deepseek",
      upstreamModel,
      harness.upstreamPort,
    );
  });

  it("reports kimi on health and provider endpoints after switching", async () => {
    await switchProvider(harness.proxyBaseUrl, "kimi");

    const [healthResponse, providerResponse] = await Promise.all([
      fetch(`${harness.proxyBaseUrl}/health`),
      fetch(`${harness.proxyBaseUrl}/api/provider`),
    ]);

    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({
      status: "ok",
      provider: "kimi",
      model: kimiUpstreamModel,
    });

    expect(providerResponse.status).toBe(200);
    expectProviderState(
      await providerResponse.json(),
      "kimi",
      kimiUpstreamModel,
      harness.upstreamPort,
    );
  });

  it("lists supported Claude-facing model ids", async () => {
    const response = await fetch(`${harness.proxyBaseUrl}/v1/models`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [
        { id: "claude-opus-4-7", object: "model" },
        { id: "claude-sonnet-4-6", object: "model" },
        { id: "claude-haiku-4-5", object: "model" },
      ],
    });
  });

  it.each(providerCases)(
    "passes through non-stream anthropic request for $provider",
    async ({ provider, expectedModel }) => {
      const metadata = {
        case: "success",
        trace_id: `${provider}-non-stream`,
      };
      const anthropicBeta = provider === "deepseek" ? "tools-2024-04-04" : undefined;

      await switchProvider(harness.proxyBaseUrl, provider);

      const response = await postMessages(
        harness,
        { metadata },
        anthropicBeta ? { "anthropic-beta": anthropicBeta } : {},
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") || "").toMatch(/^application\/json/i);
      expect(response.headers.get("x-upstream-id")).toBe("mock-upstream");
      await expect(response.json()).resolves.toMatchObject({
        model: expectedModel,
        metadata_echo: metadata,
      });

      expectForwardedRequest(harness, {
        expectedModel,
        metadata,
        anthropicBeta,
      });
    },
  );

  it.each(claudeAliasModels)(
    "maps Claude family alias %s to the current provider model",
    async (model) => {
      const metadata = { case: "success", trace_id: model };

      await switchProvider(harness.proxyBaseUrl, "deepseek");

      const response = await postMessages(harness, { model, metadata });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        model: upstreamModel,
        metadata_echo: metadata,
      });

      expectForwardedRequest(harness, {
        expectedModel: upstreamModel,
        metadata,
      });
    },
  );

  it("does not remap non-Claude model names that only contain a Claude family word", async () => {
    const metadata = { case: "success", trace_id: "custom-sonnet-proxy" };

    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await postMessages(harness, {
      model: "custom-sonnet-proxy",
      metadata,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "custom-sonnet-proxy",
      metadata_echo: metadata,
    });

    expectForwardedRequest(harness, {
      expectedModel: "custom-sonnet-proxy",
      metadata,
    });
  });

  it("passes through provider-native model names unchanged", async () => {
    const metadata = { case: "success", trace_id: "provider-native" };

    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await postMessages(harness, {
      model: upstreamModel,
      metadata,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: upstreamModel,
      metadata_echo: metadata,
    });

    expectForwardedRequest(harness, {
      expectedModel: upstreamModel,
      metadata,
    });
  });

  it("falls back to the current provider model when request model is not a string", async () => {
    const metadata = { case: "success", trace_id: "numeric-model" };

    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await postMessages(harness, {
      model: 12345,
      metadata,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: upstreamModel,
      metadata_echo: metadata,
    });

    expectForwardedRequest(harness, {
      expectedModel: upstreamModel,
      metadata,
    });
  });

  it("forwards custom Anthropic version and accept headers", async () => {
    const metadata = { case: "success", trace_id: "custom-headers" };

    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await postMessages(
      harness,
      { metadata },
      {
        accept: "application/json",
        "anthropic-version": "2024-01-01",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: upstreamModel,
      metadata_echo: metadata,
    });

    expectForwardedRequest(harness, {
      expectedModel: upstreamModel,
      metadata,
      anthropicVersion: "2024-01-01",
      accept: "application/json",
    });
  });

  it("builds a provider-model upstream body when the client body is not parsed", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-api-key": "client-placeholder",
      },
      body: "raw text body",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: upstreamModel,
    });

    const forwardedRequest = getLastRecordedRequest(harness);
    expect(forwardedRequest.body).toEqual({ model: upstreamModel });
  });

  it.each([
    { stream: false, expectedAccept: "application/json" },
    { stream: true, expectedAccept: "text/event-stream" },
  ])(
    "adds the default upstream accept header when stream is $stream and the client omits accept",
    async ({ stream, expectedAccept }) => {
      await switchProvider(harness.proxyBaseUrl, "deepseek");

      const metadata = {
        case: stream ? "stream-no-body" : "success",
        trace_id: `no-accept-${stream}`,
      };
      const body = JSON.stringify({
        ...harness.requestPayload,
        stream,
        metadata,
      });

      const response = await sendRawPost(`${harness.proxyBaseUrl}/v1/messages`, body, {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      });

      expect(response.status).toBe(stream ? 204 : 200);
      const forwardedRequest = getLastRecordedRequest(harness);
      expect(forwardedRequest.headers.accept).toBe(expectedAccept);
      expect(forwardedRequest.body.model).toBe(upstreamModel);
      expect(forwardedRequest.body.metadata).toEqual(metadata);
    },
  );

  it.each(streamingProviderCases)(
    "passes through upstream sse stream unchanged for $provider",
    async ({ provider, expectedModel }) => {
      const metadata = { case: "stream", trace_id: `${provider}-stream` };

      await switchProvider(harness.proxyBaseUrl, provider);

      const response = await postMessages(harness, {
        stream: true,
        metadata,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") || "").toMatch(/^text\/event-stream/i);
      await expect(response.text()).resolves.toBe(harness.ssePayload);

      expectForwardedRequest(harness, {
        expectedModel,
        metadata,
        stream: true,
      });
    },
  );

  it("logs only the first stream chunk while passing through chunked SSE", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await postMessages(harness, {
      stream: true,
      metadata: { case: "stream-chunks", trace_id: "stream-chunks" },
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    expectForwardedRequest(harness, {
      expectedModel: upstreamModel,
      metadata: { case: "stream-chunks", trace_id: "stream-chunks" },
      stream: true,
    });
  });

  it("ends a stream response when the upstream returns no body", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await postMessages(harness, {
      stream: true,
      metadata: { case: "stream-no-body", trace_id: "stream-no-body" },
    });

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");

    expectForwardedRequest(harness, {
      expectedModel: upstreamModel,
      metadata: { case: "stream-no-body", trace_id: "stream-no-body" },
      stream: true,
    });
  });

  it("ends the client response when the upstream stream errors after headers", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await postMessages(harness, {
        stream: true,
        metadata: {
          case: "stream-error-after-headers",
          trace_id: "stream-error-after-headers",
        },
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("message_start");
      expect(errorSpy.mock.calls.some(([message]) => message === "Upstream stream error:")).toBe(
        true,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("aborts the upstream stream when the client disconnects after receiving headers", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const body = JSON.stringify({
        ...harness.requestPayload,
        stream: true,
        metadata: {
          case: "stream-hold-open",
          trace_id: "stream-client-abort-after-headers",
        },
      });

      const response = await abortStreamingPostAfterFirstChunk(
        `${harness.proxyBaseUrl}/v1/messages`,
        body,
        {
          "content-type": "application/json",
          "x-api-key": "client-placeholder",
        },
      );

      expect(response.status).toBe(200);
      expect(response.text).toContain("message_start");
      await waitFor(() =>
        logSpy.mock.calls.some(([message]) => String(message).includes('"phase":"client_aborted"')),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("suppresses streaming abort errors when the client disconnects before upstream headers", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = JSON.stringify({
        ...harness.requestPayload,
        stream: true,
        metadata: {
          case: "stream-delay-headers",
          trace_id: "stream-client-abort-before-headers",
        },
      });

      await abortPostBeforeResponse(`${harness.proxyBaseUrl}/v1/messages`, body, {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      });

      await waitFor(() =>
        logSpy.mock.calls.some(([message]) => String(message).includes('"phase":"client_aborted"')),
      );
      await waitFor(() =>
        warnSpy.mock.calls.some(
          ([message]) => message === "[Proxy] Client disconnected, streaming aborted",
        ),
      );
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("returns a proxy error when the streaming upstream is unreachable", async () => {
    await cleanupHarness?.close();
    harness = await createHarness({
      DEEPSEEK_ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    });
    cleanupHarness = harness;

    const response = await postMessages(harness, {
      stream: true,
      metadata: { case: "stream", trace_id: "stream-upstream-error" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "internal_error",
      },
    });
  });

  it("returns a proxy error when the non-streaming upstream is unreachable", async () => {
    await cleanupHarness?.close();
    harness = await createHarness({
      DEEPSEEK_ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    });
    cleanupHarness = harness;

    const response = await postMessages(harness, {
      metadata: { case: "success", trace_id: "non-stream-upstream-error" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "internal_error",
      },
    });
  });

  it.each(providerInferenceCases)(
    "infers provider from model name $model",
    async ({ model, expectedProvider, expectedModel }) => {
      const response = await switchProviderByModel(harness.proxyBaseUrl, model);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        success: true,
        provider: expectedProvider,
        model: expectedModel,
      });
    },
  );

  it("rejects abab model names instead of treating them as minimax", async () => {
    const response = await switchProviderByModel(harness.proxyBaseUrl, "abab6.5s-chat");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unknown provider: undefined",
      available: availableProviders,
    });
  });

  it("rejects switching to qwen-plus after consolidating DashScope providers", async () => {
    const response = await switchProvider(harness.proxyBaseUrl, "qwen-plus");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unknown provider: qwen-plus",
      available: availableProviders,
    });
  });

  it("rejects provider switch requests when the body is not parsed", async () => {
    const response = await sendRawPost(`${harness.proxyBaseUrl}/api/provider`, "provider=kimi", {
      "content-type": "text/plain",
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toEqual({
      error: "Unknown provider: undefined",
      available: availableProviders,
    });
  });

  it("rejects switching to an unknown provider without changing current provider", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const unsupportedResponse = await switchProvider(harness.proxyBaseUrl, "unknown-provider");

    expect(unsupportedResponse.status).toBe(400);
    await expect(unsupportedResponse.json()).resolves.toEqual({
      error: "Unknown provider: unknown-provider",
      available: availableProviders,
    });

    const currentProviderResponse = await fetch(`${harness.proxyBaseUrl}/api/provider`);

    expect(currentProviderResponse.status).toBe(200);
    expectProviderState(
      await currentProviderResponse.json(),
      "deepseek",
      upstreamModel,
      harness.upstreamPort,
    );
  });

  it("passes through upstream anthropic error payload", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await postMessages(harness, {
      metadata: { case: "error", trace_id: "trace-3" },
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "upstream rejected request",
      },
    });
  });

  it("keeps provider state isolated across apps created from the same module import", async () => {
    await cleanupHarness?.close();
    cleanupHarness = undefined;

    const upstream = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        writeJson(res, 404, {
          type: "error",
          error: { type: "not_found_error", message: "missing" },
        });
        return;
      }

      const body = await readJsonBody(req);
      writeJson(res, 200, {
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const upstreamPort = await startServer(upstream);

    const envBackup = Object.fromEntries(
      testEnvKeys.map((key) => [key, process.env[key]]),
    ) as Record<TestEnvKey, string | undefined>;

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
    };

    for (const key of testEnvKeys) {
      setEnv(key, envValues[key]);
    }

    vi.resetModules();

    try {
      const { createApp } = await import("../../src/proxy.ts");
      const [first, second] = await Promise.all([
        startTestProxyServer(createApp),
        startTestProxyServer(createApp),
      ]);

      try {
        const switchResponse = await switchProvider(first.proxyBaseUrl, "kimi");
        expect(switchResponse.status).toBe(200);

        const [firstProviderResponse, secondProviderResponse, secondHealthResponse] =
          await Promise.all([
            fetch(`${first.proxyBaseUrl}/api/provider`),
            fetch(`${second.proxyBaseUrl}/api/provider`),
            fetch(`${second.proxyBaseUrl}/health`),
          ]);

        expect(firstProviderResponse.status).toBe(200);
        expectProviderState(
          await firstProviderResponse.json(),
          "kimi",
          kimiUpstreamModel,
          upstreamPort,
        );

        expect(secondProviderResponse.status).toBe(200);
        expectProviderState(
          await secondProviderResponse.json(),
          "deepseek",
          upstreamModel,
          upstreamPort,
        );

        expect(secondHealthResponse.status).toBe(200);
        await expect(secondHealthResponse.json()).resolves.toEqual({
          status: "ok",
          provider: "deepseek",
          model: upstreamModel,
        });
      } finally {
        await closeServer(first.proxy);
        await closeServer(second.proxy);
      }
    } finally {
      await closeServer(upstream);
      for (const key of testEnvKeys) {
        setEnv(key, envBackup[key]);
      }
      vi.resetModules();
    }
  });
});
