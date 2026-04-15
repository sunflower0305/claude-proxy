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

const upstreamApiKey = "provider-secret";
const upstreamModel = "deepseek-chat-native";
const kimiUpstreamModel = "kimi-k2.5-native";
const testEnvKeys = [
  "PROVIDER",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_ANTHROPIC_BASE_URL",
  "KIMI_API_KEY",
  "KIMI_MODEL",
  "KIMI_ANTHROPIC_BASE_URL",
] as const;

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

async function createHarness(): Promise<TestHarness> {
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
  ) as Record<(typeof testEnvKeys)[number], string | undefined>;

  setEnv("PROVIDER", "deepseek");
  setEnv("DEEPSEEK_API_KEY", upstreamApiKey);
  setEnv("DEEPSEEK_MODEL", upstreamModel);
  setEnv("DEEPSEEK_ANTHROPIC_BASE_URL", `http://127.0.0.1:${upstreamPort}`);
  setEnv("KIMI_API_KEY", upstreamApiKey);
  setEnv("KIMI_MODEL", kimiUpstreamModel);
  setEnv("KIMI_ANTHROPIC_BASE_URL", `http://127.0.0.1:${upstreamPort}`);

  vi.resetModules();
  const { createApp } = await import("../../src/proxy.ts");
  const proxy = createApp().listen(0, "127.0.0.1");
  await once(proxy, "listening");

  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("Failed to determine proxy port");
  }

  return {
    proxyBaseUrl: `http://127.0.0.1:${proxyAddress.port}`,
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

describe.sequential("proxy local integration", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("switches provider to deepseek successfully", async () => {
    const response = await switchProvider(harness.proxyBaseUrl, "deepseek");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      provider: "deepseek",
      model: upstreamModel,
      name: "deepseek",
    });
  });

  it("switches provider to kimi successfully", async () => {
    const response = await switchProvider(harness.proxyBaseUrl, "kimi");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      provider: "kimi",
      model: kimiUpstreamModel,
      name: "kimi",
    });
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
    await expect(providerResponse.json()).resolves.toEqual({
      provider: "kimi",
      model: kimiUpstreamModel,
      name: "kimi",
      baseUrl: `http://127.0.0.1:${harness.upstreamPort}`,
      availableProviders: ["deepseek", "qwen", "glm", "minimax", "kimi"],
    });
  });

  it("passes through non-stream anthropic request", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
        "anthropic-beta": "tools-2024-04-04",
      },
      body: JSON.stringify(harness.requestPayload),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") || "").toMatch(
      /^application\/json/i
    );
    expect(response.headers.get("x-upstream-id")).toBe("mock-upstream");

    await expect(response.json()).resolves.toMatchObject({
      model: upstreamModel,
      metadata_echo: harness.requestPayload.metadata,
    });

    const forwardedRequest = harness.recordedRequests.at(-1);
    expect(forwardedRequest).toBeTruthy();
    expect(forwardedRequest?.headers["x-api-key"]).toBe(upstreamApiKey);
    expect(forwardedRequest?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(forwardedRequest?.headers["anthropic-beta"]).toBe(
      "tools-2024-04-04"
    );
    expect(forwardedRequest?.body.model).toBe(upstreamModel);
    expect(forwardedRequest?.body.system).toEqual(
      harness.requestPayload.system
    );
    expect(forwardedRequest?.body.messages).toEqual(
      harness.requestPayload.messages
    );
    expect(forwardedRequest?.body.tools).toEqual(harness.requestPayload.tools);
    expect(forwardedRequest?.body.tool_choice).toEqual(
      harness.requestPayload.tool_choice
    );
    expect(forwardedRequest?.body.thinking).toEqual(
      harness.requestPayload.thinking
    );
    expect(forwardedRequest?.body.metadata).toEqual(
      harness.requestPayload.metadata
    );
    expect("extra_body" in forwardedRequest!.body).toBe(false);
    expect("thinking_budget" in forwardedRequest!.body).toBe(false);
    expect("reasoning_split" in forwardedRequest!.body).toBe(false);
  });

  it.each([
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "opus",
    "sonnet",
    "haiku",
  ])(
    "maps Claude family alias %s to the current provider model",
    async (model) => {
      await switchProvider(harness.proxyBaseUrl, "deepseek");

      const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-placeholder",
        },
        body: JSON.stringify({
          ...harness.requestPayload,
          model,
          metadata: { case: "success", trace_id: model },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        model: upstreamModel,
        metadata_echo: { case: "success", trace_id: model },
      });

      const forwardedRequest = harness.recordedRequests.at(-1);
      expect(forwardedRequest?.body.model).toBe(upstreamModel);
    }
  );

  it("does not remap non-Claude model names that only contain a Claude family word", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      },
      body: JSON.stringify({
        ...harness.requestPayload,
        model: "custom-sonnet-proxy",
        metadata: { case: "success", trace_id: "custom-sonnet-proxy" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "custom-sonnet-proxy",
      metadata_echo: { case: "success", trace_id: "custom-sonnet-proxy" },
    });

    const forwardedRequest = harness.recordedRequests.at(-1);
    expect(forwardedRequest?.body.model).toBe("custom-sonnet-proxy");
  });

  it("passes through provider-native model names unchanged", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      },
      body: JSON.stringify({
        ...harness.requestPayload,
        model: upstreamModel,
        metadata: { case: "success", trace_id: "provider-native" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: upstreamModel,
      metadata_echo: { case: "success", trace_id: "provider-native" },
    });

    const forwardedRequest = harness.recordedRequests.at(-1);
    expect(forwardedRequest?.body.model).toBe(upstreamModel);
  });

  it("falls back to the current provider model when request model is not a string", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      },
      body: JSON.stringify({
        ...harness.requestPayload,
        model: 12345,
        metadata: { case: "success", trace_id: "numeric-model" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: upstreamModel,
      metadata_echo: { case: "success", trace_id: "numeric-model" },
    });

    const forwardedRequest = harness.recordedRequests.at(-1);
    expect(forwardedRequest?.body.model).toBe(upstreamModel);
  });

  it("passes through upstream sse stream unchanged", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      },
      body: JSON.stringify({
        ...harness.requestPayload,
        stream: true,
        metadata: { case: "stream", trace_id: "trace-2" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") || "").toMatch(
      /^text\/event-stream/i
    );
    await expect(response.text()).resolves.toBe(harness.ssePayload);
  });

  it("passes through non-stream anthropic request for kimi", async () => {
    await switchProvider(harness.proxyBaseUrl, "kimi");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
        "anthropic-beta": "tools-2024-04-04",
      },
      body: JSON.stringify({
        ...harness.requestPayload,
        metadata: { case: "success", trace_id: "kimi-non-stream" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: kimiUpstreamModel,
      metadata_echo: { case: "success", trace_id: "kimi-non-stream" },
    });

    const forwardedRequest = harness.recordedRequests.at(-1);
    expect(forwardedRequest?.headers["x-api-key"]).toBe(upstreamApiKey);
    expect(forwardedRequest?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(forwardedRequest?.headers["anthropic-beta"]).toBe(
      "tools-2024-04-04"
    );
    expect(forwardedRequest?.body.model).toBe(kimiUpstreamModel);
    expect(forwardedRequest?.body.system).toEqual(
      harness.requestPayload.system
    );
    expect(forwardedRequest?.body.messages).toEqual(
      harness.requestPayload.messages
    );
    expect(forwardedRequest?.body.tools).toEqual(harness.requestPayload.tools);
    expect(forwardedRequest?.body.tool_choice).toEqual(
      harness.requestPayload.tool_choice
    );
    expect(forwardedRequest?.body.thinking).toEqual(
      harness.requestPayload.thinking
    );
    expect(forwardedRequest?.body.metadata).toEqual({
      case: "success",
      trace_id: "kimi-non-stream",
    });
  });

  it("passes through upstream sse stream unchanged for kimi", async () => {
    await switchProvider(harness.proxyBaseUrl, "kimi");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      },
      body: JSON.stringify({
        ...harness.requestPayload,
        stream: true,
        metadata: { case: "stream", trace_id: "kimi-stream" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") || "").toMatch(
      /^text\/event-stream/i
    );
    await expect(response.text()).resolves.toBe(harness.ssePayload);

    const forwardedRequest = harness.recordedRequests.at(-1);
    expect(forwardedRequest?.body.model).toBe(kimiUpstreamModel);
    expect(forwardedRequest?.body.metadata).toEqual({
      case: "stream",
      trace_id: "kimi-stream",
    });
  });

  it("infers provider from kimi model name", async () => {
    const response = await switchProviderByModel(
      harness.proxyBaseUrl,
      "kimi-k2.5"
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      provider: "kimi",
      model: kimiUpstreamModel,
      name: "kimi",
    });
  });

  it("rejects switching to qwen-plus after consolidating DashScope providers", async () => {
    const response = await switchProvider(harness.proxyBaseUrl, "qwen-plus");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unknown provider: qwen-plus",
      available: ["deepseek", "qwen", "glm", "minimax", "kimi"],
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
      available: ["deepseek", "qwen", "glm", "minimax", "kimi"],
    });

    const currentProviderResponse = await fetch(
      `${harness.proxyBaseUrl}/api/provider`
    );

    expect(currentProviderResponse.status).toBe(200);
    await expect(currentProviderResponse.json()).resolves.toEqual({
      provider: "deepseek",
      model: upstreamModel,
      name: "deepseek",
      baseUrl: `http://127.0.0.1:${harness.upstreamPort}`,
      availableProviders: ["deepseek", "qwen", "glm", "minimax", "kimi"],
    });
  });

  it("passes through upstream anthropic error payload", async () => {
    await switchProvider(harness.proxyBaseUrl, "deepseek");

    const response = await fetch(`${harness.proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      },
      body: JSON.stringify({
        ...harness.requestPayload,
        metadata: { case: "error", trace_id: "trace-3" },
      }),
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
});
