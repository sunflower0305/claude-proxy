# claude-proxy

A lightweight proxy that lets you use **Claude Agent SDK** with domestic Chinese LLMs as the backend — no Anthropic API key required.

It accepts Claude Messages API requests and forwards them to provider-native Anthropic-compatible `/v1/messages` endpoints for DeepSeek, Qwen, GLM, or MiniMax.

## Why

[Claude Code and Agent SDK](https://github.com/anthropics/claude-agent-sdk) provides powerful tool-use and agent loop capabilities, but requires Anthropic API access. This proxy intercepts requests so you can use the same Claude Code and SDK with domestic models that are faster, cheaper, or more accessible in China.

## Supported Providers

| Provider    | env key             | Models                      |
| ----------- | ------------------- | --------------------------- |
| `qwen`      | `DASHSCOPE_API_KEY` | qwen3-max                   |
| `qwen-plus` | `DASHSCOPE_API_KEY` | qwen-plus (faster, cheaper) |
| `deepseek`  | `DEEPSEEK_API_KEY`  | deepseek-chat               |
| `glm`       | `GLM_API_KEY`       | glm-5                       |
| `minimax`   | `MINIMAX_API_KEY`   | MiniMax-M2.7-highspeed      |

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/sunflower0305/claude-proxy
cd claude-proxy
npm install

# 2. Configure
cp .env.example .env
# Edit .env: set PROVIDER and the corresponding API key

# 3. Start the proxy
npm run dev
```

## Configure your app

Point your Claude Code or Agent SDK at the proxy:

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

| Method     | Path            | Description                                     |
| ---------- | --------------- | ----------------------------------------------- |
| `POST`     | `/v1/messages`  | Claude Messages API (streaming + non-streaming) |
| `GET`      | `/health`       | Health check                                    |
| `GET`      | `/v1/models`    | List available models                           |
| `GET/POST` | `/api/provider` | Get or switch current provider                  |

## Features

- Anthropic tool use passthrough for Anthropic-compatible `/v1/messages` providers
- Streaming and non-streaming responses
- Minimal request normalization with upstream model remapping
- Anthropic thinking and metadata fields passed through unchanged
- Runtime provider switching

## License

MIT

---

## Contact

If you have questions, ideas, or want to collaborate:

|                   |                   |
| ----------------- | ----------------- |
| 📧 Email          | 3268007793@qq.com |
| 📱 Phone / WeChat | 18550207121       |
