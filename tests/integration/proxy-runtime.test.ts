import http, { type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableProviders,
  buildRequestPayload,
  closeServer,
  createHarness,
  expectProviderState,
  glmUpstreamModel,
  kimiUpstreamModel,
  minimaxUpstreamModel,
  mimoUpstreamModel,
  qwenUpstreamModel,
  readJsonBody,
  setEnv,
  startServer,
  startTestProxyServer,
  switchProvider,
  testEnvKeys,
  type RecordedRequest,
  type TestEnvKey,
  type TestHarness,
  upstreamApiKey,
  upstreamModel,
  writeJson,
} from "./lib/proxy-harness.ts";

describe.sequential("proxy runtime configuration", () => {
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
