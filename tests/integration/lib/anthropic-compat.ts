import "dotenv/config";

export type TestMode = "non-stream" | "stream";

export interface AnthropicCompatibilityCase {
  name: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
}

interface TestResult {
  name: string;
  model: string;
  mode: TestMode;
  outcome: "PASS" | "FAIL" | "SKIP";
  status: number;
  details: string;
}

function getTextFromClaudeContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text =
        (block as { type?: string; text?: string }).type === "text"
          ? (block as { text?: string }).text || ""
          : "";
      return text ? [text] : [];
    })
    .join("");
}

function buildEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/v1/messages`;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

function buildMessageBody(model: string, stream: boolean) {
  return {
    model,
    max_tokens: 128,
    stream,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Reply with exactly OK." }],
      },
    ],
  };
}

async function runNonStreamingTest(
  testCase: AnthropicCompatibilityCase
): Promise<TestResult> {
  if (!testCase.apiKey) {
    return {
      name: testCase.name,
      model: testCase.model,
      mode: "non-stream",
      outcome: "SKIP",
      status: 0,
      details: "missing API key",
    };
  }

  const response = await fetch(buildEndpoint(testCase.baseUrl), {
    method: "POST",
    headers: buildHeaders(testCase.apiKey),
    body: JSON.stringify(buildMessageBody(testCase.model, false)),
  });

  const rawText = await response.text();
  let payload: any = null;

  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      name: testCase.name,
      model: testCase.model,
      mode: "non-stream",
      outcome: "FAIL",
      status: response.status,
      details: payload?.error?.message || rawText.slice(0, 300),
    };
  }

  const text = getTextFromClaudeContent(payload?.content);
  const isClaudeMessage = payload?.type === "message" && payload?.role === "assistant";

  return {
    name: testCase.name,
    model: testCase.model,
    mode: "non-stream",
    outcome: isClaudeMessage ? "PASS" : "FAIL",
    status: response.status,
    details: isClaudeMessage
      ? `stop_reason=${payload?.stop_reason ?? "unknown"}, text=${JSON.stringify(text.slice(0, 80))}`
      : `unexpected payload: ${rawText.slice(0, 300)}`,
  };
}

async function runStreamingTest(
  testCase: AnthropicCompatibilityCase
): Promise<TestResult> {
  if (!testCase.apiKey) {
    return {
      name: testCase.name,
      model: testCase.model,
      mode: "stream",
      outcome: "SKIP",
      status: 0,
      details: "missing API key",
    };
  }

  const response = await fetch(buildEndpoint(testCase.baseUrl), {
    method: "POST",
    headers: buildHeaders(testCase.apiKey),
    body: JSON.stringify(buildMessageBody(testCase.model, true)),
  });

  if (!response.ok) {
    const rawText = await response.text();
    let payload: any = null;

    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }

    return {
      name: testCase.name,
      model: testCase.model,
      mode: "stream",
      outcome: "FAIL",
      status: response.status,
      details: payload?.error?.message || rawText.slice(0, 300),
    };
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const contentType = response.headers.get("content-type") || "unknown";
  let buffer = "";
  let rawPreview = "";
  let sawMessageStart = false;
  let sawMessageStop = false;
  let sawTextDelta = false;
  let sawToolUse = false;
  let sawThinking = false;
  let outputText = "";

  function processEventBlock(block: string) {
    const lines = block.split("\n");
    let eventName = "";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!eventName || dataLines.length === 0) return;

    const data = dataLines.join("\n");
    if (data === "[DONE]") return;

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    if (eventName === "message_start") sawMessageStart = true;
    if (eventName === "message_stop") sawMessageStop = true;

    if (
      eventName === "content_block_start" &&
      payload?.content_block?.type === "thinking"
    ) {
      sawThinking = true;
    }

    if (
      eventName === "content_block_delta" &&
      payload?.delta?.type === "text_delta" &&
      typeof payload?.delta?.text === "string"
    ) {
      sawTextDelta = true;
      outputText += payload.delta.text;
    }

    if (
      eventName === "content_block_start" &&
      payload?.content_block?.type === "tool_use"
    ) {
      sawToolUse = true;
    }

    if (
      eventName === "content_block_delta" &&
      (payload?.delta?.type === "thinking_delta" ||
        typeof payload?.delta?.thinking === "string")
    ) {
      sawThinking = true;
    }
  }

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        buffer += tail;
        rawPreview += tail;
        buffer = buffer.replace(/\r\n/g, "\n");
        break;
      }

      const chunkText = decoder.decode(value, { stream: true });
      buffer += chunkText;
      rawPreview += chunkText;
      buffer = buffer.replace(/\r\n/g, "\n");

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;

        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        processEventBlock(block);
      }
    }
  }

  if (buffer.trim()) {
    processEventBlock(buffer);
  }

  const ok =
    sawMessageStart && sawMessageStop && (sawTextDelta || sawToolUse || sawThinking);

  return {
    name: testCase.name,
    model: testCase.model,
    mode: "stream",
    outcome: ok ? "PASS" : "FAIL",
    status: response.status,
    details: ok
      ? `events=message_start/message_stop, text=${JSON.stringify(outputText.slice(0, 80))}, thinking=${sawThinking}`
      : `stream incomplete: content-type=${contentType}, message_start=${sawMessageStart}, text_delta=${sawTextDelta}, tool_use=${sawToolUse}, thinking=${sawThinking}, message_stop=${sawMessageStop}, raw=${JSON.stringify(rawPreview.slice(0, 400))}`,
  };
}

export async function runAnthropicCompatibilitySuite(
  title: string,
  testCases: AnthropicCompatibilityCase[]
) {
  console.log(title);

  const results: TestResult[] = [];

  for (const testCase of testCases) {
    console.log(`\nCase: ${testCase.name} | Model: ${testCase.model}`);
    results.push(await runNonStreamingTest(testCase));
    results.push(await runStreamingTest(testCase));
  }

  console.log("\nResults:");
  for (const result of results) {
    console.log(
      `[${result.outcome}] ${result.name} / ${result.model} (${result.mode}) -> HTTP ${result.status} | ${result.details}`
    );
  }

  const failed = results.filter((result) => result.outcome === "FAIL");
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
