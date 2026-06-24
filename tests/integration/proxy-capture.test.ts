import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptureStoreFromEnv } from "../../src/capture-store.ts";
import {
  abortStreamingPostAfterFirstChunk,
  createHarness,
  listCaptureEntries,
  postMessages,
  type TestHarness,
  upstreamModel,
  waitFor,
} from "./lib/proxy-harness.ts";

describe.sequential("proxy capture logging", () => {
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
});
