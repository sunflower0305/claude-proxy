import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortPostBeforeResponse,
  abortStreamingPostAfterFirstChunk,
  createHarness,
  expectForwardedRequest,
  postMessages,
  streamingProviderCases,
  switchProvider,
  type TestHarness,
  upstreamModel,
  waitFor,
} from "./lib/proxy-harness.ts";

describe.sequential("proxy streaming integration", () => {
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
});
