import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeAliasModels,
  createHarness,
  expectForwardedRequest,
  getLastRecordedRequest,
  postMessages,
  providerCases,
  sendRawPost,
  switchProvider,
  type TestHarness,
  upstreamModel,
} from "./lib/proxy-harness.ts";

describe.sequential("proxy forwarding integration", () => {
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

  it("keeps message proxy auth disabled when PROXY_API_KEY is not set", async () => {
    const response = await postMessages(
      harness,
      { metadata: { case: "success", trace_id: "auth-disabled" } },
      { "x-api-key": "any-client-token" },
    );

    expect(response.status).toBe(200);
    expect(harness.recordedRequests).toHaveLength(1);
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
});
