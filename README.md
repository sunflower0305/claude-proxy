# claude-proxy

A lightweight proxy that lets you use Claude code or **Claude Agent SDK** with domestic Chinese LLMs as the backend — no Anthropic API key required.

It accepts Claude Messages API requests and forwards them to provider-native Anthropic-compatible `/v1/messages` endpoints for DeepSeek, Qwen, GLM, MiniMax, or Kimi.

## Why

[Claude Code and Agent SDK](https://github.com/anthropics/claude-agent-sdk) provides powerful tool-use and agent loop capabilities, but requires Anthropic API access. This proxy intercepts requests so you can use the same Claude Code and SDK with domestic models that are faster, cheaper, or more accessible in China.

## Supported Providers

| Provider   | API key            | Models                                   |
| ---------- | ------------------ | ---------------------------------------- |
| `qwen`     | `QWEN_API_KEY`     | qwen3-max or qwen-plus (faster, cheaper) |
| `deepseek` | `DEEPSEEK_API_KEY` | deepseek-chat                            |
| `glm`      | `GLM_API_KEY`      | glm-5                                    |
| `minimax`  | `MINIMAX_API_KEY`  | MiniMax-M2.7-highspeed                   |
| `kimi`     | `KIMI_API_KEY`     | kimi-k2.5                                |

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

## End-to-end CLI verification

This repo also includes a real end-to-end check that starts the local proxy, switches providers with `curl`, and verifies a local `claude` CLI call through the proxy:

```bash
npm run test:provider-cli-e2e
```

The runner:

- starts `src/proxy.ts` on a random local port
- switches `deepseek`, `qwen`, `glm`, `minimax`, and `kimi` via `POST /api/provider`
- runs `claude --bare -p "3+9=?"` against the proxy
- passes when the normalized output contains `12`
- uses a per-command timeout, overridable with `PROVIDER_CLI_E2E_COMMAND_TIMEOUT_MS`

Prerequisites:

- `curl` and `claude` must be available in `PATH`
- the provider API keys you want to verify must be configured in `.env`
- skipped providers are reported as `SKIP` when their API key is missing

The script returns exit code `1` if any runnable provider fails, and `0` when all runnable providers pass or every provider is skipped.

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
