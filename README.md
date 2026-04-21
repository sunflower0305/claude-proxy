# claude-proxy

[![CI](https://github.com/sunflower0305/claude-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/sunflower0305/claude-proxy/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/sunflower0305/claude-proxy/badge.svg?branch=master)](https://coveralls.io/github/sunflower0305/claude-proxy?branch=master)
[![npm version](https://img.shields.io/npm/v/%40sunflower0305%2Fclaude-proxy)](https://www.npmjs.com/package/@sunflower0305/claude-proxy)
[![License](https://img.shields.io/github/license/sunflower0305/claude-proxy)](https://github.com/sunflower0305/claude-proxy/blob/master/LICENSE)

`claude-proxy` is published on npm as `@sunflower0305/claude-proxy`. It is a lightweight Express proxy that lets Claude Code or the Claude Agent SDK talk to domestic Chinese LLM providers through Anthropic-compatible `/v1/messages` endpoints.

It currently supports `qwen`, `deepseek`, `glm`, `minimax`, and `kimi`.

## Install

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

The proxy reads configuration from environment variables. You can export them in your shell or create a `.env` file in the directory where you run `claude-proxy`.

Example `.env`:

```dotenv
PROVIDER=qwen
PROXY_PORT=8080
QWEN_API_KEY=your-qwen-api-key
QWEN_MODEL=qwen-plus
```

Available variables:

| Variable | Purpose |
| --- | --- |
| `PROVIDER` | Active provider. Defaults to `qwen`. |
| `PROXY_PORT` | Local server port. Defaults to `8080`. |
| `QWEN_API_KEY` | API key for Qwen. |
| `DEEPSEEK_API_KEY` | API key for DeepSeek. |
| `GLM_API_KEY` | API key for GLM. |
| `MINIMAX_API_KEY` | API key for MiniMax. |
| `KIMI_API_KEY` | API key for Kimi. |
| `QWEN_ANTHROPIC_BASE_URL`, `DEEPSEEK_ANTHROPIC_BASE_URL`, `GLM_ANTHROPIC_BASE_URL`, `MINIMAX_ANTHROPIC_BASE_URL`, `KIMI_ANTHROPIC_BASE_URL` | Override the upstream Anthropic-compatible base URL for a provider. |
| `QWEN_MODEL`, `DEEPSEEK_MODEL`, `GLM_MODEL`, `MINIMAX_MODEL`, `KIMI_MODEL` | Override the default upstream model for a provider. |

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

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/messages` | Main Anthropic Messages API proxy endpoint |
| `GET` | `/v1/models` | Lists supported Claude-facing model ids |
| `GET` | `/health` | Health check |
| `GET` / `POST` | `/api/provider` | Read or switch the active provider |

Health check:

```bash
curl http://localhost:8080/health
```

Switch provider at runtime:

```bash
curl -X POST http://localhost:8080/api/provider \
  -H "Content-Type: application/json" \
  -d '{"provider":"deepseek"}'
```

## Library Usage

The package also keeps the programmatic Express entrypoint:

```ts
import { createApp } from "@sunflower0305/claude-proxy";

const app = createApp();
app.listen(8080);
```

## Release Verification

`v1.1.0` was verified on April 21, 2026 after publishing `@sunflower0305/claude-proxy` to npm.

Verified items:

- `npm view @sunflower0305/claude-proxy version dist-tags --json` confirmed `version: 1.1.0` and `latest: 1.1.0`
- `npm install @sunflower0305/claude-proxy` completed successfully in a clean temporary directory
- the published `claude-proxy` CLI started correctly from the installed package
- `GET /health` and `GET /v1/models` returned `200 OK`
- local end-to-end proxying against a mock Anthropic-compatible upstream passed for both non-streaming and streaming `POST /v1/messages`

Observed behavior during verification:

- smoke-test startup succeeded with `PROVIDER=qwen`
- the published artifact returned the expected `health` payload with `provider: qwen` and `model: qwen-plus`
- the published artifact returned the expected Claude-facing model list from `GET /v1/models`
- the published package included the expected CLI entrypoint, `dist/` build output, `README.md`, `LICENSE`, and `.env.example`

## Development

From source:

```bash
npm install
npm run dev
```

## CI And Releases

GitHub Actions currently provides a CI baseline only:

- install dependencies with `pnpm`
- run `npm run build`
- run `npm run test:proxy-local`
- run `npm run test:coverage`
- upload `coverage/lcov.info` to Coveralls without blocking the workflow if the upload service is temporarily unavailable

Publishing to npm remains a manual step. The package still relies on `prepack` and `prepublishOnly` in `package.json` to build and verify the artifact before release.

Build and local package verification:

```bash
npm run build
env npm_config_cache=/tmp/claude-proxy-npm-cache npm pack --dry-run
```

Local integration test:

```bash
npm run test:proxy-local
```

Release notes for `v1.1.0` are available in [docs/releases/1.1.0.md](/Users/joe/ai/claude-proxy/docs/releases/1.1.0.md).

## License

MIT
