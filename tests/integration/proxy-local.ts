import assert from "node:assert/strict";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

interface RecordedRequest {
  headers: IncomingMessage["headers"];
  body: any;
}

const recordedRequests: RecordedRequest[] = [];
const upstreamApiKey = "provider-secret";
const upstreamModel = "deepseek-chat-native";

function createSsePayload() {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"deepseek-chat-native","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
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

function writeJson(res: ServerResponse, status: number, payload: unknown, headers?: Record<string, string>) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }
  res.end(JSON.stringify(payload));
}

async function main() {
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

  process.env.PROVIDER = "deepseek-dashscope";
  process.env.DEEPSEEK_API_KEY = upstreamApiKey;
  process.env.DEEPSEEK_ANTHROPIC_MODEL = upstreamModel;
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
  process.env.DASHSCOPE_API_KEY = "dashscope-secret";
  process.env.DEEPSEEK_DASHSCOPE_ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;

  const { createApp } = await import("../../src/proxy.ts");
  const proxy = createApp().listen(0, "127.0.0.1");
  await once(proxy, "listening");

  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    throw new Error("Failed to determine proxy port");
  }

  const proxyBaseUrl = `http://127.0.0.1:${proxyAddress.port}`;
  const requestPayload = {
    model: "claude-sonnet-4-20250514",
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

  try {
    const unsupportedAtStartupResponse = await fetch(
      `${proxyBaseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "client-placeholder",
        },
        body: JSON.stringify(requestPayload),
      }
    );

    assert.equal(unsupportedAtStartupResponse.status, 400);
    assert.deepEqual(await unsupportedAtStartupResponse.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "DashScope DeepSeek does not support Anthropic /v1/messages",
      },
    });
    assert.equal(recordedRequests.length, 0);

    const switchToDeepseekResponse = await fetch(`${proxyBaseUrl}/api/provider`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "deepseek" }),
    });

    assert.equal(switchToDeepseekResponse.status, 200);
    assert.deepEqual(await switchToDeepseekResponse.json(), {
      success: true,
      provider: "deepseek",
      model: upstreamModel,
      name: "DeepSeek",
    });

    const nonStreamResponse = await fetch(`${proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
        "anthropic-beta": "tools-2024-04-04",
      },
      body: JSON.stringify(requestPayload),
    });

    assert.equal(nonStreamResponse.status, 200);
    assert.match(
      nonStreamResponse.headers.get("content-type") || "",
      /^application\/json/i
    );
    assert.equal(nonStreamResponse.headers.get("x-upstream-id"), "mock-upstream");

    const nonStreamBody = await nonStreamResponse.json();
    assert.equal(nonStreamBody.model, upstreamModel);
    assert.deepEqual(nonStreamBody.metadata_echo, requestPayload.metadata);

    const forwardedNonStream = recordedRequests.at(-1);
    assert.ok(forwardedNonStream);
    assert.equal(forwardedNonStream.headers["x-api-key"], upstreamApiKey);
    assert.equal(
      forwardedNonStream.headers["anthropic-version"],
      "2023-06-01"
    );
    assert.equal(
      forwardedNonStream.headers["anthropic-beta"],
      "tools-2024-04-04"
    );
    assert.equal(forwardedNonStream.body.model, upstreamModel);
    assert.deepEqual(forwardedNonStream.body.system, requestPayload.system);
    assert.deepEqual(forwardedNonStream.body.messages, requestPayload.messages);
    assert.deepEqual(forwardedNonStream.body.tools, requestPayload.tools);
    assert.deepEqual(forwardedNonStream.body.tool_choice, requestPayload.tool_choice);
    assert.deepEqual(forwardedNonStream.body.thinking, requestPayload.thinking);
    assert.deepEqual(forwardedNonStream.body.metadata, requestPayload.metadata);
    assert.ok(!("extra_body" in forwardedNonStream.body));
    assert.ok(!("thinking_budget" in forwardedNonStream.body));
    assert.ok(!("reasoning_split" in forwardedNonStream.body));

    const streamResponse = await fetch(`${proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      },
      body: JSON.stringify({
        ...requestPayload,
        stream: true,
        metadata: { case: "stream", trace_id: "trace-2" },
      }),
    });

    assert.equal(streamResponse.status, 200);
    assert.match(
      streamResponse.headers.get("content-type") || "",
      /^text\/event-stream/i
    );
    assert.equal(await streamResponse.text(), ssePayload);

    const unsupportedProviderResponse = await fetch(`${proxyBaseUrl}/api/provider`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "deepseek-dashscope" }),
    });

    assert.equal(unsupportedProviderResponse.status, 400);
    assert.deepEqual(await unsupportedProviderResponse.json(), {
      error: "DashScope DeepSeek does not support Anthropic /v1/messages",
    });

    const currentProviderResponse = await fetch(`${proxyBaseUrl}/api/provider`);
    assert.equal(currentProviderResponse.status, 200);
    assert.deepEqual(await currentProviderResponse.json(), {
      provider: "deepseek",
      model: upstreamModel,
      name: "DeepSeek",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      availableProviders: [
        "deepseek",
        "deepseek-dashscope",
        "qwen",
        "qwen-plus",
        "glm",
        "minimax",
      ],
    });

    const errorResponse = await fetch(`${proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-placeholder",
      },
      body: JSON.stringify({
        ...requestPayload,
        metadata: { case: "error", trace_id: "trace-3" },
      }),
    });

    assert.equal(errorResponse.status, 422);
    assert.deepEqual(await errorResponse.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "upstream rejected request",
      },
    });

    console.log("proxy-local integration test passed");
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
}

main().catch((error) => {
  console.error("proxy-local integration test failed:", error);
  process.exit(1);
});
