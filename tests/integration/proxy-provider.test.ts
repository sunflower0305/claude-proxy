import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  availableProviders,
  createHarness,
  expectProviderState,
  kimiUpstreamModel,
  postMessages,
  providerCases,
  providerInferenceCases,
  sendRawPost,
  switchProvider,
  switchProviderByModel,
  type TestHarness,
  upstreamModel,
} from "./lib/proxy-harness.ts";

describe.sequential("proxy provider and auth integration", () => {
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
});
