# claude-proxy

[![CI](https://github.com/sunflower0305/claude-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/sunflower0305/claude-proxy/actions/workflows/ci.yml)
[![CD](https://github.com/sunflower0305/claude-proxy/actions/workflows/cd.yml/badge.svg)](https://github.com/sunflower0305/claude-proxy/actions/workflows/cd.yml)
[![Coverage Status](https://coveralls.io/repos/github/sunflower0305/claude-proxy/badge.svg?branch=master)](https://coveralls.io/github/sunflower0305/claude-proxy?branch=master)
[![npm version](https://img.shields.io/npm/v/%40sunflower0305%2Fclaude-proxy)](https://www.npmjs.com/package/@sunflower0305/claude-proxy)
[![npm downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fcdn.jsdelivr.net%2Fgh%2Fsunflower0305%2Fclaude-proxy%40master%2F.github%2Fbadges%2Fnpm-weekly-downloads.json&cacheSeconds=60)](https://www.npmjs.com/package/@sunflower0305/claude-proxy)
[![GitHub stars](https://img.shields.io/github/stars/sunflower0305/claude-proxy?cacheSeconds=60)](https://github.com/sunflower0305/claude-proxy/stargazers)
[![License](https://img.shields.io/github/license/sunflower0305/claude-proxy)](https://github.com/sunflower0305/claude-proxy/blob/master/LICENSE)

`claude-proxy` is published on npm as `@sunflower0305/claude-proxy`. It is a lightweight Express proxy that lets Claude Code or the Claude Agent SDK talk to domestic Chinese LLM providers through Anthropic-compatible `/v1/messages` endpoints.

It currently supports `qwen`, `deepseek`, `glm`, `minimax`, and `kimi`.

## Install

Requires Node.js 20.12 or newer.

Run without installing:

```bash
npx @sunflower0305/claude-proxy
```

Or install globally:

```bash
npm install -g @sunflower0305/claude-proxy
claude-proxy
```

## Configure

The proxy reads configuration from environment variables. You can export them in your shell or create a `.env` file in the directory where you run `claude-proxy`; `.env` loading uses Node.js built-in `.env` file support.

Example `.env`:

```dotenv
PROVIDER=deepseek
PROXY_PORT=8080
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-v4-pro
```

Available variables:

| Variable                                                                                                                                    | Purpose                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `PROVIDER`                                                                                                                                  | Active provider. Defaults to `deepseek`.                            |
| `PROXY_PORT`                                                                                                                                | Local server port. Defaults to `8080`.                              |
| `QWEN_API_KEY`                                                                                                                              | API key for Qwen.                                                   |
| `DEEPSEEK_API_KEY`                                                                                                                          | API key for DeepSeek.                                               |
| `GLM_API_KEY`                                                                                                                               | API key for GLM.                                                    |
| `MINIMAX_API_KEY`                                                                                                                           | API key for MiniMax.                                                |
| `KIMI_API_KEY`                                                                                                                              | API key for Kimi.                                                   |
| `QWEN_ANTHROPIC_BASE_URL`, `DEEPSEEK_ANTHROPIC_BASE_URL`, `GLM_ANTHROPIC_BASE_URL`, `MINIMAX_ANTHROPIC_BASE_URL`, `KIMI_ANTHROPIC_BASE_URL` | Override the upstream Anthropic-compatible base URL for a provider. |
| `QWEN_MODEL`, `DEEPSEEK_MODEL`, `GLM_MODEL`, `MINIMAX_MODEL`, `KIMI_MODEL`                                                                  | Override the default upstream model for a provider.                 |

Provider defaults:

| Provider | Model env | Default model |
| --- | --- | --- |
| **`deepseek` (default)** | `DEEPSEEK_MODEL` | **`deepseek-v4-pro`** |
| `qwen` | `QWEN_MODEL` | `qwen-plus` |
| `glm` | `GLM_MODEL` | `glm-5.1` |
| `minimax` | `MINIMAX_MODEL` | `MiniMax-M2.7-highspeed` |
| `kimi` | `KIMI_MODEL` | `kimi-k2.6` |

You can use the bundled example as a starting point:

```bash
cp node_modules/@sunflower0305/claude-proxy/.env.example .env
```

If you installed globally, create `.env` manually or export the variables in your shell before starting the proxy.

## Start The Proxy

```bash
claude-proxy
```

When the server starts, it listens on `http://localhost:8080` by default.

Point Claude Code or the Claude Agent SDK at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=any-string-works
```

Example SDK usage:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:8080",
  apiKey: "any-string",
});
```

## Runtime Endpoints

| Method         | Path            | Description                                |
| -------------- | --------------- | ------------------------------------------ |
| `POST`         | `/v1/messages`  | Main Anthropic Messages API proxy endpoint |
| `GET`          | `/v1/models`    | Lists supported Claude-facing model ids    |
| `GET`          | `/health`       | Health check                               |
| `GET` / `POST` | `/api/provider` | Read or switch the active provider         |

Health check:

```bash
curl http://localhost:8080/health
```

Switch provider at runtime:

```bash
curl -X POST http://localhost:8080/api/provider \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen"}'
```

## Library Usage

The package also keeps the programmatic Express entrypoint:

```ts
import { createApp } from "@sunflower0305/claude-proxy";

const app = createApp();
app.listen(8080);
```

## Development

From source:

```bash
npm install
npm run dev
```

## Changelog

See [CHANGELOG.md](https://github.com/sunflower0305/claude-proxy/blob/master/CHANGELOG.md) and [GitHub Releases](https://github.com/sunflower0305/claude-proxy/releases) for release notes.

## License

MIT
