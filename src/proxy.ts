/**
 * Claude API Proxy
 *
 * Converts Claude Messages API format to OpenAI-compatible format,
 * routing requests to domestic Chinese LLM providers.
 *
 * This allows using Claude Agent SDK's tool-use capabilities
 * with domestic LLMs (DeepSeek, Qwen, GLM, MiniMax) as backends.
 *
 * Usage:
 *   export ANTHROPIC_BASE_URL=http://localhost:8080
 *   export ANTHROPIC_API_KEY=any-key-works
 */

import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ========== Provider Configuration ==========

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  name: string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    model: "deepseek-chat",
    name: "DeepSeek",
  },
  "deepseek-dashscope": {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY || "",
    model: "deepseek-v3",
    name: "DeepSeek (DashScope)",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || "",
    model: "qwen3-max-2026-01-23",
    name: "Qwen / 通义千问",
  },
  "qwen-plus": {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || "",
    model: "qwen3-plus",
    name: "Qwen3 Plus (Fast)",
  },
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: process.env.GLM_API_KEY || "",
    model: "glm-4",
    name: "GLM / 智谱",
  },
  minimax: {
    baseUrl: "https://api.minimax.chat/v1",
    apiKey: process.env.MINIMAX_API_KEY || "",
    model: "MiniMax-M2.7-highspeed",
    name: "MiniMax",
  },
};

// Current provider - can be switched at runtime
let currentProvider = (process.env.PROVIDER as keyof typeof PROVIDERS) || "qwen";

function getConfig(): ProviderConfig {
  return PROVIDERS[currentProvider] || PROVIDERS.qwen;
}

const initialConfig = getConfig();
if (!initialConfig.apiKey) {
  console.warn(`Warning: API key not configured for provider: ${currentProvider}`);
  console.warn(`Please set the appropriate environment variable in .env`);
}

console.log(`Using ${initialConfig.name} as backend`);
console.log(`Model: ${initialConfig.model}`);

// ========== Model Mapping ==========

function getModelMap(): Record<string, string> {
  const cfg = getConfig();
  return {
    "claude-opus-4-5-20251101": cfg.model,
    "claude-sonnet-4-20250514": cfg.model,
    "claude-3-5-sonnet-20241022": cfg.model,
    "claude-3-opus-20240229": cfg.model,
    "claude-3-sonnet-20240229": cfg.model,
    "claude-3-haiku-20240307": cfg.model,
    opus: cfg.model,
    sonnet: cfg.model,
    haiku: cfg.model,
  };
}

// ========== Message Format Conversion ==========

function convertMessages(claudeMessages: any[]): any[] {
  const openaiMessages: any[] = [];

  for (const msg of claudeMessages) {
    if (typeof msg.content === "string") {
      openaiMessages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      const toolCalls: any[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          // Claude tool_use → OpenAI tool_calls
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === "tool_result") {
          openaiMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content:
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
          });
          continue;
        }
      }

      if (textParts.length > 0 || toolCalls.length > 0) {
        const message: any = {
          role: msg.role === "assistant" ? "assistant" : "user",
          content: textParts.join("\n\n") || null,
        };
        if (toolCalls.length > 0 && msg.role === "assistant") {
          message.tool_calls = toolCalls;
        }
        openaiMessages.push(message);
      }
    }
  }

  return openaiMessages;
}

// ========== Tool Format Conversion ==========

function convertTools(claudeTools: any[]): any[] {
  if (!claudeTools || claudeTools.length === 0) return [];
  return claudeTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

// ========== ID Generation ==========

function generateId(): string {
  return "msg_" + Math.random().toString(36).substring(2, 15);
}

function generateToolCallId(): string {
  return "toolu_" + Math.random().toString(36).substring(2, 15);
}

// ========== Streaming Request Handler ==========

async function handleStreamingRequest(
  req: express.Request,
  res: express.Response
) {
  let { model, messages, system, max_tokens = 4096, tools } = req.body;

  // Cap max_tokens for provider limits
  max_tokens = Math.min(max_tokens, 8000);

  const config = getConfig();
  const targetModel = getModelMap()[model] || config.model;

  const openaiMessages: any[] = [];

  if (system) {
    const systemContent = Array.isArray(system)
      ? system.map((s: any) => s.text || s).join("\n")
      : system;
    openaiMessages.push({ role: "system", content: systemContent });
  }

  openaiMessages.push(...convertMessages(messages));

  const requestBody: any = {
    model: targetModel,
    messages: openaiMessages,
    max_tokens,
    stream: true,
    temperature: 0,
  };

  // Qwen3: disable thinking mode for faster responses
  if (currentProvider === "qwen" || currentProvider === "qwen-plus" || currentProvider === "deepseek-dashscope") {
    requestBody.extra_body = { enable_thinking: false };
  }

  // MiniMax M2.x: disable thinking mode
  if (currentProvider === "minimax") {
    requestBody.thinking_budget = 0;
    requestBody.reasoning_split = true;
  }

  const openaiTools = convertTools(tools);
  if (openaiTools.length > 0) {
    requestBody.tools = openaiTools;
  }

  console.log(`\n[${new Date().toISOString()}] ${model} -> ${targetModel}`);
  console.log(`Messages: ${openaiMessages.length}, Tools: ${openaiTools.length}`);

  async function fetchLLMStream() {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        status: response.status,
        errorText,
        fullContent: "",
        currentToolCalls: [] as any[],
        inputTokens: 0,
        outputTokens: 0,
        hasReasoningContent: false,
        chunkCount: 0,
      };
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let fullContent = "";
    let currentToolCalls: any[] = [];
    let hasReasoningContent = false;
    let chunkCount = 0;

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (reader) {
      let decodeBuffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        decodeBuffer += decoder.decode(value, { stream: true });
        const lines = decodeBuffer.split("\n");
        decodeBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta;
              const finishReason = chunk.choices?.[0]?.finish_reason;
              chunkCount++;

              if (delta?.reasoning_content || delta?.reasoning_details) {
                hasReasoningContent = true;
                continue;
              }
              if (finishReason && !delta?.content && !delta?.tool_calls) continue;

              if (delta?.content) {
                fullContent += delta.content;
                outputTokens += delta.content.length;
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index || 0;
                  if (!currentToolCalls[idx]) {
                    currentToolCalls[idx] = {
                      id: tc.id || generateToolCallId(),
                      name: tc.function?.name || "",
                      arguments: "",
                    };
                  }
                  if (tc.function?.name) currentToolCalls[idx].name = tc.function.name;
                  if (tc.function?.arguments) currentToolCalls[idx].arguments += tc.function.arguments;
                }
              }

              if (chunk.usage) {
                inputTokens = chunk.usage.prompt_tokens || inputTokens;
                outputTokens = chunk.usage.completion_tokens || outputTokens;
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    }

    return { ok: true, fullContent, currentToolCalls, inputTokens, outputTokens, hasReasoningContent, chunkCount };
  }

  const MAX_RETRIES = 2;

  try {
    let result: Awaited<ReturnType<typeof fetchLLMStream>> | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      result = await fetchLLMStream();

      if (!result.ok) {
        console.error(`API Error: ${result.status} ${result.errorText}`);
        res.status(result.status || 500).json({
          type: "error",
          error: { type: "api_error", message: result.errorText },
        });
        return;
      }

      const isEmpty = !result.fullContent && result.currentToolCalls.length === 0;
      if (!isEmpty) break;

      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 1000;
        console.warn(`[Proxy] Empty response (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error(`[Proxy] Empty response after ${MAX_RETRIES + 1} attempts`);
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const messageId = generateId();
    const { fullContent, currentToolCalls, inputTokens, outputTokens } = result!;

    // message_start
    res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`
    );

    // text content
    if (fullContent) {
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: fullContent } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
    }

    // tool calls
    for (let i = 0; i < currentToolCalls.length; i++) {
      const tc = currentToolCalls[i];
      if (tc && tc.name) {
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i + 1, content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} } })}\n\n`);
        if (tc.arguments) {
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i + 1, delta: { type: "input_json_delta", partial_json: tc.arguments } })}\n\n`);
        }
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i + 1 })}\n\n`);
      }
    }

    // message_delta
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: currentToolCalls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`);

    // message_stop
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);

    console.log(`Done: ${inputTokens}/${outputTokens} tokens, ${currentToolCalls.length} tool calls`);
    res.end();
  } catch (error: any) {
    console.error("Request error:", error);
    res.status(500).json({ type: "error", error: { type: "internal_error", message: error.message } });
  }
}

// ========== Non-Streaming Request Handler ==========

async function handleNonStreamingRequest(
  req: express.Request,
  res: express.Response
) {
  let { model, messages, system, max_tokens = 4096, tools } = req.body;

  max_tokens = Math.min(max_tokens, 8000);

  const config = getConfig();
  const targetModel = getModelMap()[model] || config.model;

  const openaiMessages: any[] = [];

  if (system) {
    const systemContent = Array.isArray(system)
      ? system.map((s: any) => s.text || s).join("\n")
      : system;
    openaiMessages.push({ role: "system", content: systemContent });
  }

  openaiMessages.push(...convertMessages(messages));

  const requestBody: any = {
    model: targetModel,
    messages: openaiMessages,
    max_tokens,
    stream: false,
  };

  if (currentProvider === "qwen" || currentProvider === "qwen-plus" || currentProvider === "deepseek-dashscope") {
    requestBody.extra_body = { enable_thinking: false };
  }
  if (currentProvider === "minimax") {
    requestBody.thinking_budget = 0;
    requestBody.reasoning_split = true;
  }

  const openaiTools = convertTools(tools);
  if (openaiTools.length > 0) {
    requestBody.tools = openaiTools;
  }

  console.log(`\n[${new Date().toISOString()}] ${model} -> ${targetModel} (non-streaming)`);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`API Error: ${response.status} ${error}`);
      res.status(response.status).json({ type: "error", error: { type: "api_error", message: error } });
      return;
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`API returned invalid JSON: ${text.substring(0, 200)}`);
    }

    const message = data.choices?.[0]?.message;
    const content = message?.content || "";
    const toolCalls = message?.tool_calls || [];

    const claudeContent: any[] = [];
    if (content) claudeContent.push({ type: "text", text: content });

    for (const tc of toolCalls) {
      claudeContent.push({
        type: "tool_use",
        id: tc.id || generateToolCallId(),
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      });
    }

    const claudeResponse = {
      id: generateId(),
      type: "message",
      role: "assistant",
      content: claudeContent,
      model,
      stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
    };

    console.log(`Done: ${claudeResponse.usage.input_tokens}/${claudeResponse.usage.output_tokens} tokens`);
    res.json(claudeResponse);
  } catch (error: any) {
    console.error("Request error:", error);
    res.status(500).json({ type: "error", error: { type: "internal_error", message: error.message } });
  }
}

// ========== Routes ==========

app.get("/", (req, res) => {
  const config = getConfig();
  res.json({
    name: "claude-agent-proxy",
    status: "running",
    provider: currentProvider,
    model: config.model,
    endpoints: {
      messages: "POST /v1/messages",
      health: "GET /health",
      models: "GET /v1/models",
      provider: "GET|POST /api/provider",
    },
  });
});

app.post("/v1/messages", async (req, res) => {
  if (req.body.stream) {
    await handleStreamingRequest(req, res);
  } else {
    await handleNonStreamingRequest(req, res);
  }
});

app.get("/health", (req, res) => {
  const config = getConfig();
  res.json({ status: "ok", provider: currentProvider, model: config.model });
});

app.get("/v1/models", (req, res) => {
  res.json({
    data: [
      { id: "claude-opus-4-5-20251101", object: "model" },
      { id: "claude-sonnet-4-20250514", object: "model" },
      { id: "claude-3-5-sonnet-20241022", object: "model" },
    ],
  });
});

app.get("/api/provider", (req, res) => {
  const config = getConfig();
  res.json({
    provider: currentProvider,
    model: config.model,
    name: config.name,
    baseUrl: config.baseUrl,
    availableProviders: Object.keys(PROVIDERS),
  });
});

app.post("/api/provider", (req, res) => {
  const { provider, model } = req.body;

  let targetProvider = provider;
  if (!targetProvider && model) {
    const m = model.toLowerCase();
    if (m.includes("qwen")) targetProvider = "qwen";
    else if (m.includes("deepseek")) targetProvider = "deepseek";
    else if (m.includes("glm")) targetProvider = "glm";
    else if (m.includes("minimax") || m.includes("abab")) targetProvider = "minimax";
  }

  if (!targetProvider || !PROVIDERS[targetProvider]) {
    return res.status(400).json({
      error: `Unknown provider: ${targetProvider}`,
      available: Object.keys(PROVIDERS),
    });
  }

  if (!PROVIDERS[targetProvider].apiKey) {
    return res.status(400).json({
      error: `API key not set for: ${targetProvider}`,
    });
  }

  const old = currentProvider;
  currentProvider = targetProvider;
  console.log(`Provider: ${old} -> ${currentProvider}`);

  const config = PROVIDERS[targetProvider];
  res.json({ success: true, provider: currentProvider, model: config.model, name: config.name });
});

// ========== Start ==========

const PORT = parseInt(process.env.PROXY_PORT || "8080", 10);

app.listen(PORT, () => {
  const cfg = getConfig();
  console.log(`
╔════════════════════════════════════════════════╗
║         claude-agent-proxy                     ║
╠════════════════════════════════════════════════╣
║  http://localhost:${PORT}
║  Backend: ${cfg.name} (${cfg.model})
╠════════════════════════════════════════════════╣
║  Set these env vars in your app:               ║
║  ANTHROPIC_BASE_URL=http://localhost:${PORT}
║  ANTHROPIC_API_KEY=any-string-works            ║
╚════════════════════════════════════════════════╝
  `);
});
