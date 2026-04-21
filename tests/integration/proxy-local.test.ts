import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  anthropicBeta?: string;
  stream?: boolean;
}

const upstreamApiKey = "provider-secret";
const upstreamModel = "deepseek-chat-native";
const qwenUpstreamModel = "qwen-plus-native";
const glmUpstreamModel = "glm-5-native";
const kimiUpstreamModel = "kimi-k2.5-native";
const minimaxUpstreamModel = "minimax-m2-native";
const providerCases = [
  { provider: "deepseek", expectedModel: upstreamModel },
  { provider: "qwen", expectedModel: qwenUpstreamModel },
  { provider: "glm", expectedModel: glmUpstreamModel },
  { provider: "minimax", expectedModel: minimaxUpstreamModel },
  { provider: "kimi", expectedModel: kimiUpstreamModel },
] as const;
const streamingProviderCases = providerCases.filter(
  ({ provider }) => provider === "deepseek" || provider === "kimi"
);
const claudeAliasModels = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "opus",
  "sonnet",
  "haiku",
] as const;
const providerInferenceCases = [
  { model: "kimi-k2.5", expectedProvider: "kimi", expectedModel: kimiUpstreamModel },
  {
    model: "minimax-m2",
    expectedProvider: "minimax",
    expectedModel: minimaxUpstreamModel,
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

async function startProxyServer(createApp: CreateApp) {
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
  headers?: Record<string, string>
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
  upstreamPort: number
) {
  expect(payload).toEqual({
    provider,
    model: expectedModel,
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    availableProviders,
  });
}

function expectForwardedRequest(
  harness: TestHarness,
  expectation: ForwardedRequestExpectation
) {
  const forwardedRequest = getLastRecordedRequest(harness);

  expect(forwardedRequest.headers["x-api-key"]).toBe(upstreamApiKey);
  expect(forwardedRequest.headers["anthropic-version"]).toBe("2023-06-01");
  if (expectation.anthropicBeta) {
    expect(forwardedRequest.headers["anthropic-beta"]).toBe(
      expectation.anthropicBeta
    );
  } else {
    expect(forwardedRequest.headers["anthropic-beta"]).toBeUndefined();
  }

  expect(forwardedRequest.body.model).toBe(expectation.expectedModel);
  expect(forwardedRequest.body.system).toEqual(harness.requestPayload.system);
  expect(forwardedRequest.body.messages).toEqual(harness.requestPayload.messages);
  expect(forwardedRequest.body.tools).toEqual(harness.requestPayload.tools);
  expect(forwardedRequest.body.tool_choice).toEqual(
    harness.requestPayload.tool_choice
  );
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
      { "x-upstream-id": "mock-upstream" }
    );
  });
  const upstreamPort = await startServer(upstream);

  const envBackup = Object.fromEntries(
    testEnvKeys.map((key) => [key, process.env[key]])
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
    ...envOverrides,
  };

  for (const key of testEnvKeys) {
    setEnv(key, envValues[key]);
  }

  vi.resetModules();
  const { createApp } = await import("../../src/proxy.ts");
  const { proxy, proxyBaseUrl } = await startProxyServer(createApp);

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

async function switchProvider(baseUrl: string, provider: string) {
  return fetch(`${baseUrl}/api/provider`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
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
  headers: Record<string, string> = {}
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
    }
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

    const currentProviderResponse = await fetch(
      `${harness.proxyBaseUrl}/api/provider`
    );

    expect(currentProviderResponse.status).toBe(200);
    expectProviderState(
      await currentProviderResponse.json(),
      "deepseek",
      upstreamModel,
      harness.upstreamPort
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
      harness.upstreamPort
    );
  });

  it("lists supported Claude-facing model ids", async () => {
    const response = await fetch(`${harness.proxyBaseUrl}/v1/models`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [
        { id: "claude-opus-4-6", object: "model" },
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
      const anthropicBeta =
        provider === "deepseek" ? "tools-2024-04-04" : undefined;

      await switchProvider(harness.proxyBaseUrl, provider);

      const response = await postMessages(
        harness,
        { metadata },
        anthropicBeta ? { "anthropic-beta": anthropicBeta } : {}
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") || "").toMatch(
        /^application\/json/i
      );
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
    }
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
    }
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
      expect(response.headers.get("content-type") || "").toMatch(
        /^text\/event-stream/i
      );
      await expect(response.text()).resolves.toBe(harness.ssePayload);

      expectForwardedRequest(harness, {
        expectedModel,
        metadata,
        stream: true,
      });
    }
  );

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
    }
  );

  it("rejects abab model names instead of treating them as minimax", async () => {
    const response = await switchProviderByModel(
      harness.proxyBaseUrl,
      "abab6.5s-chat"
    );

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

  it("rejects switching to an unknown provider without changing current provider", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const unsupportedResponse = await switchProvider(
      harness.proxyBaseUrl,
      "unknown-provider"
    );

    expect(unsupportedResponse.status).toBe(400);
    await expect(unsupportedResponse.json()).resolves.toEqual({
      error: "Unknown provider: unknown-provider",
      available: availableProviders,
    });

    const currentProviderResponse = await fetch(
      `${harness.proxyBaseUrl}/api/provider`
    );

    expect(currentProviderResponse.status).toBe(200);
    expectProviderState(
      await currentProviderResponse.json(),
      "deepseek",
      upstreamModel,
      harness.upstreamPort
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
      testEnvKeys.map((key) => [key, process.env[key]])
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
    };

    for (const key of testEnvKeys) {
      setEnv(key, envValues[key]);
    }

    vi.resetModules();

    try {
      const { createApp } = await import("../../src/proxy.ts");
      const first = await startProxyServer(createApp);
      const second = await startProxyServer(createApp);

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
          upstreamPort
        );

        expect(secondProviderResponse.status).toBe(200);
        expectProviderState(
          await secondProviderResponse.json(),
          "deepseek",
          upstreamModel,
          upstreamPort
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
