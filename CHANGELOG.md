# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-04-15

First public npm release of `@sunflower0305/claude-proxy`.

### Added

- public scoped npm package: `@sunflower0305/claude-proxy`
- executable `claude-proxy` CLI entrypoint
- programmatic `createApp()` export for Express-based usage
- packaged TypeScript declarations in `dist/`
- bundled publish assets: `README.md`, `LICENSE`, and `.env.example`
- Anthropic-compatible proxy support for `qwen`, `deepseek`, `glm`, `minimax`, and `kimi`
- support for both non-streaming JSON and streaming SSE proxy responses
- runtime provider switching via `GET/POST /api/provider`

### Verified

- npm installation from the published registry artifact
- installed CLI startup from the published package
- `GET /health` and `GET /v1/models`
- end-to-end non-streaming and streaming proxying against a local mock upstream
- end-to-end non-streaming and streaming proxying against the real Qwen upstream

Detailed release notes: [docs/releases/1.0.0.md](/Users/joe/ai/claude-proxy/docs/releases/1.0.0.md)
