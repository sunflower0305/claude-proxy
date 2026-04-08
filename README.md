# claude-agent-proxy

A lightweight proxy that lets you use **Claude Agent SDK** with domestic Chinese LLMs as the backend — no Anthropic API key required.

It converts the Claude Messages API format to OpenAI-compatible format and routes requests to DeepSeek, Qwen, GLM, or MiniMax.

## Why

[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) provides powerful tool-use and agent loop capabilities, but requires Anthropic API access. This proxy intercepts SDK requests so you can use the same SDK with domestic models that are faster, cheaper, or more accessible in China.

## Supported Providers

| Provider | env key | Models |
|----------|---------|--------|
| `qwen` | `DASHSCOPE_API_KEY` | qwen3-max |
| `qwen-plus` | `DASHSCOPE_API_KEY` | qwen3-plus (faster, cheaper) |
| `deepseek` | `DEEPSEEK_API_KEY` | deepseek-chat |
| `deepseek-dashscope` | `DASHSCOPE_API_KEY` | deepseek-v3 via DashScope |
| `glm` | `GLM_API_KEY` | glm-4 |
| `minimax` | `MINIMAX_API_KEY` | MiniMax-M2.7-highspeed |

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/sunflower0305/claude-agent-proxy
cd claude-agent-proxy
npm install

# 2. Configure
cp .env.example .env
# Edit .env: set PROVIDER and the corresponding API key

# 3. Start the proxy
npm run dev
```

## Configure your app

Point your Claude Agent SDK at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=any-string-works
```

Or in code:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:8080",
  apiKey: "any-string",
});
```

## Switch provider at runtime

```bash
# Switch to DeepSeek
curl -X POST http://localhost:8080/api/provider \
  -H "Content-Type: application/json" \
  -d '{"provider": "deepseek"}'
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/messages` | Claude Messages API (streaming + non-streaming) |
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List available models |
| `GET/POST` | `/api/provider` | Get or switch current provider |

## Features

- Full tool use support (Claude `tool_use` ↔ OpenAI `tool_calls`)
- Streaming and non-streaming responses
- Automatic retry on empty responses (up to 2 retries)
- Thinking mode disabled by default for faster responses
- Runtime provider switching

## License

MIT

---

## Contact

If you have questions, ideas, or want to collaborate:

| | |
|---|---|
| 📧 Email | 3268007793@qq.com |
| 📱 Phone / WeChat | 18550207121 |
