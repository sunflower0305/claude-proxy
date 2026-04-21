# Changelog

All notable changes to this project will be documented in this file.

## [1.1.1] - 2026-04-21

Patch release of `@sunflower0305/claude-proxy`.

### Added

- GitHub Actions CD workflow for tag-driven npm publishing and GitHub Release creation

### Changed

- release documentation and README publishing guidance now reflect the new CD workflow

### Fixed

- Claude-facing model mappings now expose `claude-opus-4-7` instead of `claude-opus-4-6`
- local integration tests now validate the updated Claude model identifier

Detailed release notes: [docs/releases/1.1.1.md](/Users/joe/ai/claude-proxy/docs/releases/1.1.1.md)

## [1.1.0] - 2026-04-21

Second public npm release of `@sunflower0305/claude-proxy`.

### Added

- GitHub Actions CI workflow for build, local integration tests, and coverage reporting
- broader local integration coverage for `qwen`, `glm`, and `minimax`

### Changed

- proxy runtime state is now isolated per `createApp()` instance to support multiple app instances safely
- model and provider inference logic was refactored to better handle dynamic provider identification
- startup banner formatting and release documentation were polished
- Kimi documentation and default model references were updated to `kimi-k2.6`

### Fixed

- test cleanup now avoids duplicate resource shutdowns
- redundant proxy console logging was removed to reduce noise and overhead

Detailed release notes: [docs/releases/1.1.0.md](/Users/joe/ai/claude-proxy/docs/releases/1.1.0.md)

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
