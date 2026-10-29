# Changelog

## [1.12.0] - 2026-10-29

### Summary

Feature release. The hermes image gains the `sqlite3` CLI for direct inspection and recovery of SQLite databases (state.db, kanban DBs) and the `anthropic` extra, so `provider=anthropic` works on an image whose lazy installs are disabled. Fixes the dashboard-container crash loop: the web UI dist is now built with the version manager's pinned node (receipt mismatch previously forced a boot-time rebuild that could not succeed by construction), and `HERMES_WEB_DIST` pins the dashboard to the baked dist. Also refreshes five pinned dependencies (weekly sweep, 7-day cooldown): hermes-agent v0.21.6 → v0.22.2, `pi-coding-agent` 1.1.0 → 1.3.0, `opencode-ai` 1.19.0 → 1.19.3, pnpm 12.12.1 → 12.14.0, mise 2026.10.8 → 2026.10.13.

### Added

- `sqlite3` CLI baked into the hermes image for direct SQLite inspection and recovery; the venv keeps the bundled newer SQLite, so the two do not interact (#207)
- `anthropic` extra baked into the hermes venv, so `provider=anthropic` loads on an image with lazy installs disabled (#207)

### Fixed

- Dashboard container crash loop on hermes images: the web dist is built with the version manager's pinned node instead of the base image's node, so the build receipt no longer reads stale; `HERMES_WEB_DIST` pins the dashboard to the baked dist and boot no longer attempts a rebuild that cannot succeed (#208)

### Dependency Updates

- updated hermes-agent from v0.21.6 to v0.22.2
- updated @earendil-works/pi-coding-agent from 1.1.0 to 1.3.0
- updated opencode-ai from 1.19.0 to 1.19.3
- updated pnpm from 12.12.1 to 12.14.0
- updated mise from 2026.10.8 to 2026.10.13

### Changes

- 066a1f3 fix(hermes): build web dist with PM's pinned node; pin dashboard to baked dist (#208)
- a17bb47 feat(hermes): bake sqlite3 CLI and the anthropic extra into the image (#207)
- b0cb7eb deps: bump pi 1.1.0→1.3.0, opencode 1.19.0→1.19.3, pnpm 12.12.1→12.14.0, mise 2026.10.8→2026.10.13, hermes v0.21.6→v0.22.2 (7-day cooldown) (#206)

## [1.11.1] - 2026-10-22

### Summary

Security maintenance release responding to the eMudhra intermediate-CA compromise (2026-10-20: eight eMudhra intermediate CA keys publicly recoverable since April 2025 — any client whose CA bundle still trusts `emSign ECC Root CA - G3` can be MITM'd). The Debian base digest rotates forward to pick up `ca-certificates` 20260816, which distrusts the emSign roots — load-bearing because hermes-agent v0.21.6 routes TLS through the OS certificate store, making the image's Debian store the runtime trust source for the hermes venv. uv moves 0.13.0 → 0.13.4 (its vendored CA bundle still trusted the emSign root; GHSA-hq85-5cpj-mr62), and `certifi==2026.10.19` is explicitly installed into the hermes venv (upstream exact-pins a vulnerable 2026.5.20; GHSA-6q48-6c7w-9gw2) until the hermes-agent clone ref moves past a release carrying the fix. The base image's corepack/pnpm installs also gain retry loops — registry.npmjs.org fetches intermittently fail with 503 at the CDN edge and corepack has no built-in retry.

### Dependency Updates

- updated uv from 0.13.0 to 0.13.4
- added explicit `certifi==2026.10.19` install to the hermes venv (was transitive 2026.5.20 via hermes-agent)
- updated debian base image digest (ca-certificates 20260816, emSign root distrust)

### Changes

- ab21993 fix(deps): eMudhra emSign root removal — uv 0.13.4, certifi 2026.10.19, debian digest rotation (#202)

## [1.11.0] - 2026-10-19

### Summary

Maintenance release. The headline is the new opt-in `--egress <allowlist>` flag (Tier-2 egress control): run an agent container with no external network route except the HTTPS hosts you allowlist — `harness --egress api.github.com,.openrouter.ai` builds a per-run internal network plus a squid CONNECT-only gateway (allow `host:port` / raw TCP is deferred; use each service's HTTPS endpoint). Also fixes three egress subnet/sweep bugs found in end-to-end smoke testing, hardens the agent entrypoints, and fixes the release-gating integration suite (built images are now pulled into the local docker store before smoke runs, and the smoke model is back on an OpenRouter-carried model). Dependency refresh: `hermes-agent` v2026.9.24 → v0.21.6 (upstream switched to `vX.Y.Z` tag names), `pi-coding-agent` 0.87.1 → 1.1.0 (its 1.0: fullscreen TUI, codemode/MCP wave), `opencode-ai` 1.19.0, and CPython 3.13.15 → 3.14.7 in the hermes image (required by hermes v0.21.6's core deps). No CLI changes beyond the new flag.

### Dependency Updates

- updated hermes-agent from v2026.9.24 to v0.21.6
- updated @earendil-works/pi-coding-agent from 0.87.1 to 1.1.0
- updated opencode-ai from 1.18.32 to 1.19.0
- updated gh from 2.101.0 to 2.102.0
- updated uv from 0.12.19 to 0.13.0
- updated pnpm from 12.7.0 to 12.12.1
- updated mise from 2026.9.15 to 2026.10.8
- updated CPython (uv-managed, hermes image) from 3.13.15 to 3.14.7
- updated debian base image digest

### Upstream Release Notes

#### hermes-agent v2026.9.24 → v0.21.6

**v0.21.6** — First release cut by the new stable release pipeline (one attempt ref, a tested Docker image, a receipt tag at publish). Rolls up ~2,100 merged PRs / ~8,867 non-merge commits since v0.21.5; full curated notes deferred to v0.22.0. Undocumented-on-purpose highlights listed in the release body include: live streaming transcription on CLI/TUI/Desktop (`stt.streaming`); voice-chat turns routed to a dedicated model with reasoning off; third-party plugin isolation via per-profile plugin hosts (`plugins.isolation: host`) and a Settings ▸ Plugins home; favorite/pinned models, usage chips, and rate-limit reasons in the Desktop picker; local models in `hermes model` plus llama.cpp CUDA on Linux x64/arm64; pluggable layered language packs; summary-first `hermes status` (`--short`/`--full`); review-pane diff scope selector; cron-store writability warnings; approval flags for credential uploads and invisible Unicode in terminal commands; Discord setup with token check; GPT-6.1 Sol and Claude Sonnet 5.5 / Haiku 5.5 in catalogs. Security: dashboard auth hardening — spoofed `X-Forwarded-For` resetting the rate limit, unbounded auth audit-log values, missing request-body size limit on `/auth/` routes, and a non-loopback login-code redirect allowing session takeover (reported by Tenable, TRA-725..728).

#### @earendil-works/pi-coding-agent 0.87.1 → 1.1.0

**v0.99.0** — Codemode and MCP: connect MCP servers (stdio or streamable HTTP, with OAuth) from `mcp.json` or `pi mcp add|remove|list|login|logout`; the `codemode` tool runs model-written JavaScript in a QuickJS sandbox that calls pi's tools in parallel; `tool_search` declares undeclared tools on demand. System theme from the terminal's own palette; Sign in with ChatGPT; experimental virtual models (extensions route each request to a different physical model); classifier models from codemode or llama.cpp.

**v0.99.1** — GPT-6.1 Sol on OpenAI, Azure OpenAI, and OpenAI Codex (new Codex default); fix for `/login openai` failing in the bundled release with a missing `openai-chatgpt.js` module.

**v0.99.2** — MCP stays out of the way: `codemode`-exposed servers no longer block the first prompt; `oauth.clientName` for picky OAuth clients; `"auth": {"provider": …}` bearer tokens from a provider's `/login`; Anthropic workload identity federation; `/reload` enables newly added `defaultTools`.

**v1.0.0** — Fullscreen TUI by default (`tuiMode: "regular"` keeps scrollback); ~40% leaner codemode prompts with recovery-oriented errors; `models.generateImages()` in codemode scripts using session credentials; Radius sign-in from `/login`; Anthropic copy-code login for headless setups; MCP OAuth hardening (`authServerMetadataUrl`, RFC 9207 `iss` checks, per-server credentials, step-up sign-in); `quietStartup: "header"`.

**v1.0.1** — Nix flake (`nix run github:earendil-works/pi/stable`); project overrides for user-level MCP servers (`.pi/mcp.json` can enable/disable/re-expose per project); MCP Client ID Metadata Documents (`oauth.clientRegistration: "cimd"`); `pi.registerToolRenderer()` for unregistered tools; Cloudflare Clef classifiers.

**v1.0.2** — `samplingParamsByThinkingLevel` in `models.json` for per-thinking-level sampling overrides on OpenAI-compatible APIs.

**v1.0.3** — Azure provider renamed `azure-openai-responses` → `azure` (breaking: rename the `auth.json` key or re-`/login`, plus `models.json`/`settings.json` references); Azure Foundry Chat Completions deployments starting with `azure/deepseek-v4-pro`; codemode `image()` saves to temp files; fixes for cancelled-OAuth `refresh_token_invalidated`, codemode dying after a pnpm global update, and `read EIO` crashes when the terminal goes away.

**v1.0.4** — `*` patterns in `--tools`/`--exclude-tools` (e.g. `--tools read,codemode,'mcp__radius__*'`); `--no-mcp` for one run; codemode `read()` returns image blocks; fixes for multiline syntax highlighting, MCP native-client registration (`invalid_redirect_uri`), MCP session shutdown races, stalled Bedrock HTTP/2 retries, and codemode built-in patching crashes.

**v1.1.0** — OSC 7501 program status reporting (working/blocked/done/failed) for terminals and agent dashboards; Claude Haiku 5.5; `+name`/`-name` `--tools` entries that adjust the default selection instead of replacing it; GPT-6 Luna as a classifier (Decisions API, image input); native llama.cpp decision models (Julia-1, Laya, Kev, lev, OpenJev) via `/v1/systemone`.

#### opencode-ai 1.18.32 → 1.19.0

**v1.19.0** — `opencode upgrade --major` upgrades to OpenCode 2; TUI `/update` installs updates manually (no more auto-updates on launch); allow the OpenAI `ultrafast` service tier; validate PTY connection origins and tickets.

### Changes

- 868c5ba RFC: opt-in egress allowlisting for agent containers (#195)
- fd4ba01 deps: bump gh 2.101.0->2.102.0, pi 0.87.1->1.1.0, opencode 1.18.32->1.19.0, uv 0.12.19->0.13.0, pnpm 12.7.0->12.12.1, mise 2026.9.15->2026.10.8, hermes v2026.9.24->v0.21.6, debian digest (#196)
- 43b6973 fix: egress subnet/sweep bugs + agent entrypoint hardening (smoke-tested end to end) (#197)
- 11cccdc fix: hermes image CPython 3.13.15 -> 3.14.7 so hermes v0.21.6 installs its core deps (#198)
- dddcc0b fix(ci): integration smoke — pull built images into local store; restore OpenRouter model (#199)

## [1.10.4] - 2026-10-04

### Summary

Dependency-refresh patch release. The headline is the `hermes-agent` v2026.9.24 bump (two rollup tags: a Desktop plugin SDK wave, a Connectors page with one-click MCP bring-up for installed plugins, per-profile stop/start/restart, and webhook deliveries mirrored into chat) and the `pi-coding-agent` 0.87.1 bump (Claude Opus 5.5, GPT-6 Sol/Luna support, and Grok 4.7 as the new xAI default). Also bumps `opencode-ai` 1.18.32, `uv` 0.12.19, `pnpm` 12.7.0, and `mise` 2026.9.15. No CLI changes.

### Dependency Updates

- updated hermes-agent from v2026.9.14 to v2026.9.24
- updated @earendil-works/pi-coding-agent from 0.86.1 to 0.87.1
- updated opencode-ai from 1.18.31 to 1.18.32
- updated uv from 0.12.17 to 0.12.19
- updated pnpm from 12.5.1 to 12.7.0
- updated mise from 2026.9.12 to 2026.9.15

### Upstream Release Notes

#### hermes-agent v2026.9.14 → v2026.9.24

**v2026.9.21** — Rollup of ~1,800 PRs into a tagged release (curated notes deferred to v0.22.0). Host-wide gateway singleton lock; Desktop attaches to the running host backend instead of spawning a second one; `--format stream-json` structured output for the CLI; `skills.auto_load` pins skills into every new session's prompt; `session_search` after/before bounds; `hermes sessions set-journal-mode`; LTX 2.5 and Kling O3 in the video catalogs; a large run of profile/multiplex isolation, cron, kanban, and state.db fixes.

**v2026.9.24** — Rollup of ~460 PRs into a tagged release. Desktop plugin SDK wave (composer draft API, session-list and row-decoration slots, typed settings/skills/toolsets/profiles bridges, public event bridge for plugin backends); Simple/Advanced interface mode; Connectors page replacing the MCP tab, with "Connect now" bringing up a freshly installed plugin's MCP servers in every open chat; French, German, and Spanish Desktop catalogs plus an RTL/LTR text-direction setting; custom model entry from the composer and Settings; per-profile stop/start/restart and `gateway.standalone`; live dock showing the standing `/goal` and queued prompts in CLI and TUI; webhook deliveries mirrored into the target chat session; GPT-6 Sol/Terra/Luna and Claude Opus 5.5 in the Nous and OpenRouter catalogs; hot-path performance work across config loading, tool registry, and gateway message handling.

#### @earendil-works/pi-coding-agent 0.86.1 → 0.87.1

**v0.87.0** — Canonical session context and extension boundaries: append-only model-context edits (`ContextEditEntry`) and actionable `turn_end` / `agent_before_settle` lifecycle hooks; `context_with_system` full-transcript extensions; per-model image input limits with cache-safe resizing. Breaking changes: `shouldStopAfterTurn` removed in favor of `finishTurn`; `SessionManager` is canonical for provider context; expanded `TurnEndEvent` and new `AgentBeforeSettleEvent` shapes. Fixes include string context-edit replacements, edited-context usage accounting, `/bug` uploads in offline mode, and text files starting with `GIF` being misclassified as images.

**v0.87.1** — Latest frontier models: Claude Opus 5.5 on Anthropic (adaptive thinking, 1M context window), GPT-6 Sol and GPT-6 Luna (OpenAI API keys, Codex subscriptions, GitHub Copilot); xAI sessions now default to Grok 4.7. Fixes: split-turn compaction summaries with Claude Fable 5.1, missing or invalid `--mode` values now error instead of being silently ignored, image-only user messages no longer rejected by some OpenAI-compatible providers.

#### opencode-ai 1.18.31 → 1.18.32

**v1.18.32** — Bedrock image attachments are only hoisted for Claude, Nova, and Llama 4 models; fixed Together AI streaming usage reporting.

### Changes

- 94247dd deps: bump pi 0.86.1->0.87.1, opencode 1.18.31->1.18.32, uv 0.12.17->0.12.19, pnpm 12.5.1->12.7.0, mise 2026.9.12->2026.9.15, hermes v2026.9.14->v2026.9.24 (#193)

## [1.10.3] - 2026-09-27

### Summary

Dependency-refresh patch release. The headline is the `hermes-agent` v2026.9.14 bump (a remote-desktop session-expiry fix and a state.db writer-handle leak fix) and the `pi-coding-agent` 0.86.1 bump (prompt-cache warming, a `/bug` reporter, and a new Meta Muse provider). Also bumps `gh` 2.101.0, `opencode-ai` 1.18.31, `uv` 0.12.17, `pnpm` 12.5.1, `mise` 2026.9.12, and CPython 3.13.15. No CLI changes.

### Dependency Updates

- updated hermes-agent from v2026.9.11 to v2026.9.14
- updated @earendil-works/pi-coding-agent from 0.85.1 to 0.86.1
- updated gh from 2.100.0 to 2.101.0
- updated opencode-ai from 1.18.30 to 1.18.31
- updated uv from 0.12.13 to 0.12.17
- updated pnpm from 12.4.1 to 12.5.1
- updated mise from 2026.9.6 to 2026.9.12
- updated CPython (uv-managed, hermes image) from 3.13.14 to 3.13.15

### Upstream Release Notes

#### hermes-agent v2026.9.11 → v2026.9.14

**v2026.9.14** — Patch rollup for tagged deployments. Remote dashboard sessions no longer expire on Desktop refresh bursts (concurrent refresh-token rotations are coalesced so a wake burst can no longer trip reuse detection and revoke the session); refresh runs off the event loop so a slow identity provider no longer freezes `/api/status`. Long-lived processes (gateway, dashboard backend, ACP/CLI readers) stop leaking duplicate state.db writer handles, and readers attach read-only.

#### @earendil-works/pi-coding-agent 0.85.1 → 0.86.1

**v0.86.0** — Cost-aware prompt-cache warming during long tool runs and optionally while idle; `/bug` reporting with redacted diagnostics, optional transcripts, or ZIP export; transcript-aware prompt and tool updates that survive resume and branch navigation; the offline Radius model catalog; per-model compaction budgets. Breaking changes to the custom-provider streaming API (`Context` → normalized `TranscriptContext`) and to `ToolCall.arguments`/`ToolResultMessage.details` typing.

**v0.86.1** — Meta Muse provider sign-in (`/login meta` or `META_API_KEY`); faster repeat launch via Node's persistent compile cache; fixed clipboard copy in containers and WSL without WSLg; fixed z.ai `Prompt too long` not being recognized as context overflow.

#### opencode-ai 1.18.30 → 1.18.31

**v1.18.31** — Restored ACP session model, effort, mode, and reasoning chunk boundaries when loading, resuming, or forking sessions; remote config authentication errors are now shown during startup; summarized adaptive thinking requested for GitHub Copilot models.

### Changes

- ad731b3 deps: bump gh 2.100.0->2.101.0, pi 0.85.1->0.86.1, opencode 1.18.30->1.18.31, uv 0.12.13->0.12.17, pnpm 12.4.1->12.5.1, mise 2026.9.6->2026.9.12, hermes v2026.9.11->v2026.9.14, CPython 3.13.14->3.13.15 (#191)

## [1.10.2] - 2026-09-21

### Summary

Dependency-refresh patch release. The hermes image now installs a uv-managed CPython (3.13.14) instead of the Debian system python3, so hermes runs against the SQLite bundled by python-build-standalone (3.53.1) rather than Debian trixie's libsqlite3 3.46.1 — which is exposed to the WAL-reset corruption bug fixed upstream in SQLite 3.51.3. Also bumps `hermes-agent` v2026.8.31 → v2026.9.11 (the state.db reliability release), `opencode-ai` 1.18.29 → 1.18.30, `uv` 0.12.10 → 0.12.13, `pnpm` 12.3.4 → 12.4.1, `mise` 2026.9.1 → 2026.9.6, and rotates the `debian:stable-slim` digest. No CLI changes.

### Dependency Updates

- updated hermes-agent from v2026.8.31 to v2026.9.11
- updated opencode-ai from 1.18.29 to 1.18.30
- updated uv from 0.12.10 to 0.12.13
- updated pnpm from 12.3.4 to 12.4.1
- updated mise from 2026.9.1 to 2026.9.6
- updated debian:stable-slim base image digest

### Upstream Release Notes

#### hermes-agent v2026.8.31 → v2026.9.11

**v2026.9.7 (v0.21.1)** — Rollup patch of main since v0.21.0 for tagged deployments: codebase modularization, file-operation and startup performance work, provider/model updates, desktop session controls and browser annotations, MCP authorization improvements, cron scheduling/delivery fixes, and delegation reliability improvements.

**v2026.9.11 (v0.21.2)** — The state.db patch release, fixing the fragility v0.21.0's session-store rewrite introduced for some installs: no more second writers cancelling each other's locks (profile gateways, dashboard, cron lifecycle guard, `doctor --fix`), healthy WAL databases no longer wedge on `DeletedWalGenerationError`, FTS-index damage degrades to search-only instead of failing the conversation, one corrupt row no longer kills `sessions list`/export/insights, sessions never bind to or read another profile's database, and opening state.db no longer takes the write lock when nothing needs writing (one-shot processes behind a busy gateway: 4–20 s stall → 0.01 s). Also: multi-profile isolation hardening (secondary-profile bots no longer inherit the default profile's allow-lists, credentials, or vault secrets), desktop backend spawn storms fixed, a password-blind credential vault (1Password/Bitwarden/local vault sign-in, payment, and address fill without the agent seeing secrets), a curated SHA-pinned plugin catalog with a unified Plugins page, the Nous free tier with `/login` from chat, and a guided first launch.

#### opencode-ai 1.18.29 → 1.18.30

**v1.18.30** — Astra system prompt for GPT-6 models; preserved Bedrock DeepSeek model IDs (incl. ARN-based) so they resolve correctly; Azure and OpenAI provider SDK compatibility updates; reasoning-effort variants for supported GitLab GPT and Claude models.

### Changes

- 21703f5 deps: bump opencode 1.18.30, uv 0.12.13, pnpm 12.4.1, mise 2026.9.6, hermes v2026.9.11, debian digest (#189)
- 16d5e81 docs: fix release skill and README deploy-guide paths (#187)


## [1.10.1] - 2026-09-13

### Summary

Dependency-refresh patch release: bumps every pinned tool in the container images. `pnpm` moves 10.34.5 → 12.3.4 (major) — global installs now land in `$PNPM_HOME/bin` (added to `PATH`), the release-cooldown env var is spelled `PNPM_CONFIG_MINIMUM_RELEASE_AGE`, and `pnpm-workspace.yaml` gains an `allowBuilds` entry for `@biomejs/biome` (v11+ makes ignored postinstalls a hard error); `pnpm/action-setup` is pinned to v6.1.0, required because pnpm ≥ 12 ships as a native binary the older action cannot install. Also bumps `pi-coding-agent` 0.80.10 → 0.85.1, `opencode-ai` 1.18.4 → 1.18.29, `hermes-agent` v2026.8.19 → v2026.8.31 (v0.21.0 "Pantheon"), `gh` 2.98.0 → 2.100.0, `uv` 0.11.30 → 0.12.10, `mise` 2026.7.11 → 2026.9.1, and rotates the `debian:stable-slim` digest. No CLI changes.

### Dependency Updates

- updated pnpm from 10.34.5 to 12.3.4
- updated pnpm/action-setup from v6 (0e279bb) to v6.1.0 (ea17c68)
- updated @earendil-works/pi-coding-agent from 0.80.10 to 0.85.1
- updated opencode-ai from 1.18.4 to 1.18.29
- updated hermes-agent from v2026.8.19 to v2026.8.31
- updated gh from 2.98.0 to 2.100.0
- updated uv from 0.11.30 to 0.12.10
- updated mise from 2026.7.11 to 2026.9.1
- updated debian:stable-slim base image digest

### Upstream Release Notes

#### @earendil-works/pi-coding-agent 0.80.10 → 0.85.1

**v0.81.0** — Local llama.cpp model management (router connection, Hugging Face model search/download, explicit load/unload with live progress); extensions can register complete pi-ai providers; Qwen Token Plan built-in providers; usage accounting extended to tools, compaction, and branch summaries.

**v0.81.1** — Deterministic checksummed source archives in GitHub releases; resilient compaction and branch summaries with retry lifecycle events across interactive/JSON/RPC/SDK consumers.

**v0.82.0** — Constrained tool sampling (strict JSON Schema `prefer`/`require` plus OpenAI Lark/regex grammars, gated by model capability metadata); OpenRouter and Kimi Code OAuth sign-in via `/login`; session-aware streaming bash integrations exposing `PI_SESSION_ID`/`PI_PROVIDER`/`PI_MODEL` env.

**v0.82.1** — Claude Opus 5 on Anthropic and Bedrock with adaptive thinking (incl. `xhigh`), inference profiles, prompt caching; `ANTHROPIC_AUTH_TOKEN` gateway bearer auth; faster revalidating model catalogs.

**v0.83.0** — `pi auth print-api-key` / `print-bearer-token` credential export with OAuth refresh; headless OpenRouter sign-in (paste redirect URL/auth code over SSH); Claude Opus 5 on GitHub Copilot with 1M context; **breaking:** bundled TypeBox upgraded to 1.3.7 removing deprecated APIs (`Type.Base`, `Value.Mutate`, …) — extensions must migrate.

**v0.84.0** — Fullscreen TUI mode (sticky editor, independently scrollable transcript, draggable scrollbars); Mermaid diagram and Unicode LaTeX rendering in transcripts; per-directory context overrides via `AGENTS.override.md`; arbitrary OpenAI-compatible `samplingParams`; Baseten provider. **Breaking:** `message_update` JSON/RPC events now emit only deltas (cumulative `message` field removed); `ModelsStreamTransforms` renamed `ModelsRequestTransforms`.

**v0.84.1** — Qwen Token Plan Individual provider; `pi auth check` credential readiness verification; improved fullscreen interaction (multi-click selection, half-page scrolling).

**v0.84.2** — Fullscreen transcript search (`Ctrl+Shift+F` with incremental highlighting); configurable default tools globally or per project; configurable fullscreen exit output.

**v0.84.3** — Optional native PowerShell tool on Windows; safer managed updates (stage, verify, atomically activate); `/thinking` selector with searchable defaults and session-scoped persistence. **Breaking:** `GoogleThinkingLevel` renamed `GoogleApiThinkingLevel` (+ `ResolvedGoogleThinkingLevel`).

**v0.84.4** — Terminal capability overrides (hyperlink/image/truecolor); extension UI prompt events; RPC `clear_queue` for steering/follow-up messages; fullscreen selection copy controls.

**v0.85.0** — Persistent Claude thinking effort across turns (with signed-thinking mismatch recovery); fullscreen transcript controls (jump-to-latest, embedded working indicator); restorable in-memory sessions via the SDK.

**v0.85.1** — GPT-6 Astra for OpenAI API keys and Codex subscriptions; 5× faster Alt+wheel scrolling in fullscreen; fix for SDK import failures from accidentally published internals.

#### opencode-ai 1.18.4 → 1.18.29

**v1.18.5–v1.18.9** — Claude adaptive-thinking handling across more response shapes; Mistral prompt caching and reasoning-history fixes; branch-specific repository caches; MCP OAuth/session reconnect fixes; legacy MCP SDK client compatibility restored; V2 desktop sidecar opt-in backed by the bundled CLI service.

**v1.18.10–v1.18.15** — Auto-discovery of available Modal models; chronological message ordering fixed for imported/legacy IDs; compaction keeps complete recent turns with clearer summaries for smaller models; Azure GPT-5.5+ reasoning fixes; xAI single device-code login for headless/remote; PDF attachments for vision-capable Copilot models; blob attachments fixed in web UI.

**v1.18.16–v1.18.20** — Unknown top-level config fields ignored instead of failing parsing; retry jitter to prevent retry storms; native OpenAI/Anthropic passthroughs for Cloudflare AI Gateway; Codex rate limits matched to ChatGPT tiers; resumable subagent failures surfaced with `task_id`; retries for `network_error` finish reasons; Azure CLI Entra ID sign-in (no API key).

**v1.18.21–v1.18.25** — Continue on unknown finish reasons; Vertex AI multi-region Gemini routing through REP endpoints; Cloudflare AI Gateway fixes for third-party providers and dotted Anthropic model IDs; GitHub auth for immutable OIDC subject tokens; Bedrock reasoning responses no longer cached into unreplayable empty messages.

**v1.18.26–v1.18.29** — Claude 5 stale-thinking-block tolerance; Bedrock GPT-5.6 `none` reasoning effort; five-minute default provider header/streamed-chunk timeouts (disable with `false`); Anthropic thinking block-binding limited to Claude 5.1+; Codex OAuth model filtering recognizes integer GPT versions (e.g. `gpt-6`).

#### hermes-agent v2026.8.19 → v2026.8.31

**v2026.8.27 (v0.20.6)** — Patch rollup of ~525 PRs since v0.20.5, tagged for downstream consumers: consent-gated real-profile browsing and a broad fix/stabilization wave.

**v2026.8.31 (v0.21.0, "Pantheon")** — Major rollup (~525 PRs in the tag window; ~2,475 PRs since v0.20.0): Bot Mode built into the desktop app (society of named agents with group chats); `hermes peer` bot-to-bot DMs; cron jobs with persistent memory and continuity; live subagent steering from `delegate_task`; merged MCP command center with health checks; Ctrl+P command palette and fuzzy `/model` picker; agent-driven in-app browser; six new providers (Meta Model API, CommandCode, Tencent TokenPlan, Nebius, …); write-approval protection for AGENTS.md/skills/memory against prompt injection.

### Changes

- 766959c deps: bump pnpm 10.34.5 → 12.3.4 (major) + action-setup v6.1.0 (#185)
- 4bff54a deps: bump gh 2.98.0→2.100.0, pi 0.80.10→0.85.1, opencode 1.18.4→1.18.29, uv 0.11.30→0.12.10, mise 2026.7.11→2026.9.1, hermes-agent v2026.8.19→v2026.8.31, debian digest (#184)

## [1.10.0] - 2026-09-02

### Summary

Minor release with two new CLI flags and a runtime default change. `-e/--env-file` may now be repeated to merge multiple env files (previously a second `-e` silently dropped the first — minimist last-value-wins), e.g. `harness -e base.env -e project.env -p "..."`. The new repeatable `--port` flag publishes container ports to the host with up-front spec validation, e.g. `harness --port 8080:8080 -p "..."`. On macOS, harness now auto-detects Apple's `container` CLI and prefers it over docker — `HARNESS_CONTAINER_RUNTIME=apple` is no longer needed; `HARNESS_CONTAINER_RUNTIME=docker` forces docker, and the `apple` value stays as a deprecated alias. Also fixes a DNS hint and context mount for the apple runtime, and serves docs at https://harness.boldblack.ai/docs with corrected canonicals.

### Changes

- b290cf7 feat: add --port flag to publish container ports to the host (#178)
- f56baf1 feat: support repeated -e/--env-file for merging multiple env files (#134)
- 79c5722 feat: auto-detect container runtime, promote Apple container as default (#179)
- 2916715 fix: apple host.docker.internal DNS hint + Hermes context mount (#118, #119) (#126)
- 9db1e48 docs: serve docs at harness.boldblack.ai/docs (#171)
- 92268d8 fix: point docs site_url at the brand domain for correct canonicals (#175)

## [1.9.13] - 2026-08-30

### Summary

Dependency refresh: bumps `hermes-agent` to v2026.8.19 (v0.20.5), `gh` to 2.98.0, and `cosign` to 3.1.3 (with updated release checksums). Drops the `hermes-agent-64189` secret-source re-pull backport patch — the fix is now upstream (hermes-agent #64177) — and removes the now-empty `patches/` directory along with the dead `MISE_VERSION` build-arg.

### Dependency Updates

- updated gh from 2.97.0 to 2.98.0
- updated cosign from 3.1.2 to 3.1.3
- updated hermes-agent from v2026.8.3 to v2026.8.19

### Upstream Release Notes

#### hermes-agent v2026.8.3 → v2026.8.19

**v2026.8.13 (v0.20.1)** — Patch rollup of ~656 PRs since v0.20.0 (1,444 commits, ~481 issues closed): stabilization and fix waves across the desktop app, gateway platforms, installers, tool system, and provider catalogs.

**v2026.8.16 (v0.20.2)** — Patch rollup of ~397 PRs since v0.20.1: desktop multi-gateway Connections registry, profile-scoped refreshes, and MCP health checks; CLI Windows update probes and Kitty keyboard protocol; persisted model routes and Telegram DM topics on the gateway; prompt caching for LiteLLM Claude; cron and auth-resolution hardening; installer robustness on Linux and Windows.

**v2026.8.16.2 (v0.20.3)** — Patch rollup of ~125 PRs since v0.20.2: MCP 2.x SDK migration with 2026-07-28 stateless protocol support; bundled Bot Mode plugin with the core teammate protocol; CommandCode provider plugin; Python subprocess runtime isolation hardening; Cua Driver 0.20 contracts; kanban worktree/dispatch fixes; cron scheduler self-heal (EMFILE recovery, stale-claim reconciliation); session handoff data-loss fixes; plugin install security scanning.

**v2026.8.18 (v0.20.4)** — Patch rollup of ~74 PRs since v0.20.3: desktop glass/translucency work and tabbed SESSIONS|BOTS sidebar; Bot Mode group-chat fixes; NVIDIA SkillEvaluator advisory scanning on skill installs; cron media-send hardening; SessionDB event-loop and contention fixes; `hermes update` parked-branch honesty; kanban native OS notifications.

**v2026.8.19 (v0.20.5)** — Patch rollup of ~323 PRs since v0.20.4: Bot Mode group-room threads, foldable conversation summaries, and PDF/file attachments with drag & drop; keyless web tier (free vendor rotation with ring failover, web search with zero keys); CLI fuzzy `/model` picker and Ctrl+P command palette; execution-discipline and runtime stall guards; `hermes update` receipts and fleet `--plan` verification; `hermes worktree list/prune`; multi-question clarify; cron persistent memory and per-job reasoning effort.

### Changes

- 1fca58c deps: bump gh 2.97.0→2.98.0, cosign 3.1.2→3.1.3, hermes-agent v2026.8.3→v2026.8.19 (#176)

## [1.9.12] - 2026-08-18

### Summary

Honors `HERMES_BASE_URL` in the cloud-mode entrypoint, mirroring the existing `HERMES_PROVIDER` handling. When set, the hermes container's `model.base_url` config is populated from the environment instead of being cleared.

### Changes

- ccf2c77 feat(hermes): honor HERMES_BASE_URL in cloud mode entrypoint (#173)

## [1.9.11] - 2026-08-16

### Summary

Fixes the Apple Container runtime pulling the wrong architecture on Apple Silicon (it now passes `--platform` to `image pull`), honors `HERMES_PROVIDER` in cloud-mode entrypoint so multi-key env files can pin the provider, and adds `boldblackai/skills` as a default tap on first run so fresh containers can discover the public skills marketplace without a manual step. The release skill also now opens a cross-repo PR to bump the image tag in `create-dispatch`.

### Changes

- cebc5a6 feat: bump create-bclaw image tag in release skill (#161)
- 807f449 feat(hermes): add boldblackai/skills as default tap on first run (#163) (#168)
- 060d4a5 fix(hermes): honor HERMES_PROVIDER in cloud mode entrypoint (#132) (#167)
- 41a3b8b fix: pass --platform to apple/container image pull (#169)

## [1.9.10] - 2026-08-10

### Summary

Adds local text-to-speech via `kokoro-onnx` in the hermes image, and lands integration tests that gate the release pipeline with real end-to-end container smoke tests. Bumps `gh` to 2.97.0 and `hermes-agent` to v2026.8.3 (v0.20.0, The Herald Release). Drops the slack-invalid-blocks patch that was upstreamed in v0.20.0.

### Dependency Updates

- updated gh from 2.96.0 to 2.97.0
- updated hermes-agent from v2026.7.20 to v2026.8.3

### Upstream Release Notes

#### hermes-agent v2026.7.20 → v2026.8.3

**v2026.7.30 (v0.19.1)** — Patch tag rolling up ~1,000 PRs since v0.19.0: bug-fix and salvage waves across the gateway, voice subsystem, desktop app, and installer; Buzz/Nostr channel, FLUX3 video, Telegram media reliability, voice-mode regressions.

**v2026.8.3 (v0.20.0 — The Herald Release)** — Streaming conversational voice with barge-in and on-device wake words across all platforms. Agent-to-Agent protocol (A2A v1.0). Signed outbound webhooks. Grounded research with verifiable citations. Desktop app becomes a platform (artifacts, plugin SDK, quick-entry). CLI power-user wave (`!` shell mode, `/init`, `/diff`, `/context`, `/focus`). Mid-turn redirects. Tool self-recovery wave. Smarter, gentler context compression. Prompt caching covers tool schemas on Anthropic. `hermes -w` cold start 14s → 1.8s. Default tool-call iteration limit 90 → 500. New providers: Gemini 3.1 Pro, Gemini 3.6 Flash, claude-opus-5, deepseek-v4-flash-0731. New platforms: Buzz (Nostr), Vercel AI Gateway. Slack Block Kit clarify buttons, reaction triggers, outbound payload sanitization.

### Changes

- 75e2877 deps: bump gh 2.96.0→2.97.0, hermes-agent v2026.7.20→v2026.8.3 (#165)
- 9205780 feat: add kokoro-onnx to hermes image for local TTS (#162)
- 1c94dd9 fix: pre-create combined.txt so hermes preserves world-readable mode (#159)
- c6daff7 fix: capture agent exit code before chmod in run_harness (#158)
- 01329d6 fix: chmod workspace after agent run so assertions can read created files (#157)
- 953c93b fix: restore per-adapter model selection, tighten multi_file prompt (#156)
- 94eb9c5 fix: use bare model ID for all adapters in smoke tests (#155)
- 8104189 fix: remove connectivity scenario, use per-adapter model in smoke tests (#154)
- ab4f640 fix: make temp workspaces writable by the container user (#153)
- 1f2e5e6 feat: expand smoke tests with file read/write scenarios (#152)
- 9aceb54 fix: use concrete OpenRouter model for opencode smoke test (#151)
- cc539b0 fix: integration test failures — macOS leg, model names, release gate (#150)
- d202495 feat: integration tests that gate the release pipeline (#149)
- 38b671d RFC: Integration Tests — Real End-to-End Container Tests (#138)

## [1.9.9] - 2026-08-01

### Summary

Fixes cosign image verification failure caused by the release pipeline moving from tag pushes to push-to-main. The identity regexp in `verifyImage` now matches `@refs/heads/main` exactly. Also removes dead code from `docker.yml`: the `release: published` trigger, `type=semver` tag, and `tags/v` ref check — all unreachable since the switch away from tag-push triggers.

### Changes

- 0c5e343 fix: accept refs/heads/main in cosign identity verification (#147)

## [1.9.8] - 2026-08-01

### Summary

Fixes the base Docker image version tag. The `merge-base` job in `docker.yml` only produced version-tagged base images on tag refs, not on release commits pushed to main. Adds a `type=raw` tag gated on the `release v` commit sentinel, matching the `merge-variant` pattern.

### Changes

- f904582 fix: produce version-tagged base image on release commits (#145)

## [1.9.7] - 2026-08-01

### Summary

Consolidates the release pipeline into a single workflow. npm publish (OIDC trusted publishing) is now part of `tag-on-merge.yml` instead of a separate `publish.yml`, fixing a GitHub Actions limitation where a `GITHUB_TOKEN`-pushed tag cannot trigger another workflow. Docker `merge-variant` jobs detect release commits on push to main and produce version-tagged images directly.

### Changes

- 4089aad fix: merge npm publish into tag-on-merge workflow (#142)

## [1.9.6] - 2026-08-01

### Summary

Fixes the `tag-on-merge` release workflow to use a `push` trigger instead of `pull_request`, resolving a permission issue where fork PRs receive a read-only `GITHUB_TOKEN` that blocked tag creation. Also removes the old logo from README.md.

> **Not published to npm / no version-tagged Docker images.** The `push` trigger gave the workflow write permissions, but the tag push came from `github-actions[bot]` — GitHub Actions suppresses workflow triggers from `GITHUB_TOKEN`, so `publish.yml` never fired. Fixed in 1.9.7 by merging npm publish into `tag-on-merge.yml`.

### Changes

- 20ebf4e fix: switch tag-on-merge to push trigger for fork PR token permissions (#140)

## [1.9.5] - 2026-08-01

### Summary

Replaces manual `npm publish` with fully automated trusted publishing (OIDC) via GitHub Actions. The agent never touches npm credentials or pushes tags — it opens a release PR from its fork, and merging that PR triggers the entire pipeline: auto-tagging, npm publish with provenance attestations, GitHub release creation, and Docker image builds. This closes the Socket.dev supply chain score gap by adding provenance to the npm package (the Docker images already had cosign + SLSA).

> **Not published to npm / no version-tagged Docker images.** The `pull_request` trigger gave the workflow a read-only `GITHUB_TOKEN` for fork PRs, so `git push` of the tag failed with 403. Fixed in 1.9.6 (trigger) and 1.9.7 (publish merge).

### Changes

- fb979e4 feat: automated npm trusted publishing (OIDC) + tag-on-merge release pipeline (#130)

## [1.9.4] - 2026-07-31

### Summary

Maintenance release that rolls up the 7-day-cooldown dependency bumps across all three agent images and backports an upstream hermes-agent Slack Block Kit fix. `pi-coding-agent` moves to 0.80.10 (Kimi Coding adaptive-thinking compatibility), `opencode-ai` jumps to 1.18.4 (completing the Desktop v2 migration, adding skill discovery, Snowflake Cortex, session snapshots/revert, and a `--mini` CLI mode), and `hermes-agent` moves to v2026.7.20 — Hermes v0.19.0 "Quicksilver," a speed release (~80% faster first-token) that also adds in-terminal subscription management, default smart approvals, and Bitwarden/1Password secret sources. `pnpm`, `mise`, `uv`, and `cosign` are bumped as well.

The harness-level change applies a new build-time patch (`hermes-agent-slack-invalid-blocks-fix.patch`) over the `v2026.7.20` tree so Slack stops rejecting entire messages when a Block Kit text element ends up with zero characters (blank quote separators, empty table cells, empty code fences).

### Dependency Updates

- updated pnpm from 10.33.2 to 10.34.5
- updated `@earendil-works/pi-coding-agent` from 0.80.9 to 0.80.10
- updated mise from 2026.4.23 to 2026.7.11
- updated opencode-ai from 1.15.10 to 1.18.4
- updated uv from 0.11.19 to 0.11.30
- updated cosign from 3.0.6 to 3.1.2
- updated hermes-agent from v2026.7.7.2 to v2026.7.20

### Upstream Release Notes

#### @earendil-works/pi-coding-agent 0.80.9 → 0.80.10

**v0.80.10** — Kimi Coding models now use adaptive thinking correctly (K3 exposes its supported `max` level and replays empty-signature thinking blocks); fixed inherited Kimi K3 pricing/thinking metadata; restored xAI models that 0.80.9 had removed from the catalog.

#### opencode-ai 1.15.10 → 1.18.4

**v1.15.11–v1.15.13** — `headerTimeout` provider config (10s default for OpenAI setups); experimental OpenAI WebSocket response transport; ACP `acp-next` prompts/slash-commands/usage; Anthropic Opus 4.7+ adaptive reasoning keeps summarized thinking; session custom metadata via API/SDK; responsive/configurable TUI prompt.

**v1.16.0–v1.16.2** — Managed workspace cloning that keeps dirty and untracked files; move sessions between workspaces; OpenAI models through AWS Bedrock; **skill discovery and file-based agent loading**; `run --replay` for interactive session replay; added **Snowflake Cortex** provider; subagents can be backgrounded; edit tool now refuses loose matches that could overwrite the wrong code.

**v1.17.0–v1.17.5** — New `fff`-backed faster file search; Cohere North model support; `X-Session-Id` headers for sticky-routing proxies; connector-based auth flows and stored provider credentials; v2 API endpoints to create/fetch sessions; `cwd` support for local MCP servers; Snowflake Cortex external-browser OAuth.

**v1.17.6–v1.17.10** — Broad MCP compatibility/capability fixes; **MCP resource template listing and read tools**; Opencode-managed provider integration; added a **`--mini` CLI mode**.

**v1.17.11–v1.17.15** — **Session snapshots and revert** (roll a session back to an earlier message including file changes); Chrome-style `mod+1`–`mod+9` tab cycle shortcuts and draggable desktop tabs; `code mode` MCP adapter for confined orchestration scripts; yolo auto-approve permission mode in the TUI.

**v1.17.16–v1.17.20** — Composer add-menu (files, commands, context, shell mode); inline file-browser tabs in the side panel; Grok reasoning-effort variants and xAI prompt-cache/PDF handling; Meta and GitHub Copilot model-handling fixes; GPT-5.6 / Azure updates.

**v1.18.0–v1.18.4** — **Completed the Desktop v2 migration** with a setting to toggle between new and old layouts during the transition; subagents can no longer launch nested subagents by default (configurable `subagent_depth`); Kimi adaptive-thinking controls on Anthropic-compatible providers; restored Azure Cognitive Services endpoint support.

#### hermes-agent v2026.7.7.2 → v2026.7.20

**v2026.7.20 — Hermes v0.19.0 "The Quicksilver Release"** — Cold-start time-to-first-token dropped ~80% (4.3s → 0.9s) across CLI, gateway, TUI, desktop, and cron; reasoning models stream their thinking live by default; 20+ desktop perf PRs (14× faster streaming markdown, virtualized diffs, snappy session switching). **`/subscription` and `/topup`** let you manage your Nous plan entirely from the terminal (with matching desktop billing tab). **Smart approvals are now the default** — an LLM reviewer judges flagged commands, plus user-defined deny rules and `/deny <reason>`. **Bitwarden and 1Password secret sources** via a pluggable `SecretSource` interface (multiple vaults, precedence, provenance). Live subagent transcripts (`tail -f`) plus durable background delegation; a durable delivery-obligation ledger so finished responses survive gateway crashes (Telegram/Discord/Slack); profile-based gateway message routing (one bot token, many isolated profiles). New providers Fireworks AI, DeepInfra, and Upstage Solar; new models GPT-5.6, grok-4.5 GA, kimi-k3, claude-fable-5/sonnet-5; `max`/`ultra` reasoning tiers with per-model overrides; `hermes sessions export` (Markdown/Quarto/HTML/HF trace, with `--redact`); a security-hardening round across credential surfaces.

### Changes

- 40d4106 fix(hermes): backport Slack Block Kit invalid_blocks empty text element fix (#137)
- dbbf913 chore: bump eligible dependencies (7-day cooldown) (#133)

## [1.9.3] - 2026-07-28

### Summary

Hermes-only patch release. Backports upstream hermes-agent PR [#64189](https://github.com/NousResearch/hermes-agent/pull/64189), applied at image build time over the `v2026.7.7.2` tree baked into the hermes image, so plugin-registered secret sources such as `aws_ssm` are actually consulted during the first process's initial environment load. Previously they registered after the first `load_hermes_dotenv()` call and were silently ignored, emitting `secrets.sources names unknown source(s)`. No CLI, adapter, or dependency changes.

### Changes

- 27d70bc fix(hermes): backport secret-source re-pull after plugin discovery (#136)

## [1.9.2] - 2026-07-18

### Summary

Maintenance release with a new home-directory safety guard, Chromium support for the hermes agent, and several dependency bumps. Harness now refuses to run from your home directory by default (it would mount all of `$HOME`, exposing dotfiles and credentials); pass the new `--mount-entire-home` flag to opt in. The hermes image gains the shared libraries Chromium needs to run Playwright browsers, and the hermes web UI is now pre-built into the image. Also bumps `pi-coding-agent` to 0.80.9 and `hermes-agent` to v2026.7.7.2 (Hermes Agent v0.18.x).

```bash
# harness refuses to run from $HOME by default; opt in explicitly:
harness --mount-entire-home
```

### Dependency Updates

- updated `@earendil-works/pi-coding-agent` from `0.79.2` to `0.80.9`
- updated `hermes-agent` from `v2026.6.19` to `v2026.7.7.2`
- updated `gh` from `2.95.0` to `2.96.0`
- downgraded `cosign` from `3.1.1` to `3.0.6`

### Upstream Release Notes

#### @earendil-works/pi-coding-agent 0.79.2 → 0.80.9

**v0.79.3** — Fixed inherited OpenAI GPT-5.4/5.5 and Codex context-window metadata to use the 272k Codex backend limit, avoiding an over-limit billing hazard.

**v0.79.4** — Automatic first-run theme detection from the terminal background; `SHA256SUMS` integrity files added to standalone binary releases; many inherited fixes (bash tool output draining, signal-based shutdown cleanup, pnpm global `pi update`, CJK overlay alignment, custom-provider key literals).

**v0.79.5** — Provider-scoped `auth.json` API-key `env` overrides (Cloudflare/Azure/Vertex/Bedrock/cache/proxy); a global `httpProxy` setting; Vercel AI Gateway attribution headers; several inherited provider/terminal fixes.

**v0.79.6** — Fixed the HTTP dispatcher to preserve a caller's deliberate `fetch` override; fixed inherited OpenCode Go DeepSeek V4 thinking-off compatibility.

**v0.79.7** — Automatic light/dark theme mode that follows terminal color-scheme changes; `pi update` now updates pi only by default (use `--all` for packages); extension helpers `CONFIG_DIR_NAME` and edit-diff exports; Warp terminal inline image rendering.

**v0.79.8** — Selective provider base entry points (`pi-ai/base`, `pi-agent-core/base`); Mistral prompt caching with cached-token accounting; post-compaction token estimates in compact results/events; `openrouter/fusion` alias.

**v0.79.9** — Chat-template thinking compatibility (`chat_template_kwargs`) for vLLM/HF models like DeepSeek; corrected GLM-5.2 Fireworks routing and OpenRouter `xhigh` support; inherited fixes (fuzzy `edit` block preservation, WSL `bash.exe` stdin, deep-branch quadratic perf).

**v0.79.10** — Extension compaction events now carry `reason`/`willRetry`; safer `pi update` that installs the exact checked version and links the changelog; fixed `find` tool handling of nested-repo gitignore rules.

**v0.80.1** — Fixes only: Bedrock scoped `AWS_PROFILE` endpoint resolution, Fireworks Anthropic-compat session-affinity/tool defaults, and Together MiniMax M2.7 metadata.

**v0.80.2** — `ApiKeyCredential` now uses the `type: "api_key"` discriminator with provider-scoped `env`; renamed `ExecutionEnvExecOptions` → `ShellExecOptions`; restored legacy compat stream aliases and the `detectCompat` fallback; fixed request-scoped auth resolution for providers like Cloudflare.

**v0.80.3** — Anthropic Claude Sonnet 5 support (adaptive thinking); `outputPad` horizontal padding; configurable `externalEditor`; RPC `get_entries`/`get_tree`; extension `session_info_changed` events; modern Azure Foundry endpoints; default OpenAI model now `gpt-5.5`.

**v0.80.5** — Maintenance release (no curated changelog).

**v0.80.6** — New `max` thinking level above `xhigh` (GPT-5.6 / adaptive Claude, `--thinking max`); request-wide input-token pricing tiers for accurate long-context cost accounting; `~` home expansion for `shellPath`; fixed post-compaction output-token budgeting and GPT-5.x long-context pricing.

**v0.80.7** — **Breaking:** removed `compat.sendSessionIdHeader`, replaced by `compat.sessionAffinityFormat`. Cache-friendly dynamic tool loading (Anthropic/OpenAI Responses preserve the cache prefix); `Ctrl+X` to copy the last assistant message; Fable 5 `xhigh`/`max` thinking; `toolChoice` support for OpenAI/Codex Responses; fixed system-prompt date-based cache invalidation.

**v0.80.8** — Unified `ModelRuntime` (model config, provider-owned `/login`, dynamic catalogs); live `/model` catalog refresh + `pi update --models`; xAI device-code OAuth and Grok 4.5 Responses. **SDK breaking changes:** replaced `authStorage`/`modelRegistry` with async `modelRuntime`, removed redundant `ModelRuntime` projections, and `ModelRegistry.refresh()` is now async.

**v0.80.9** — Kimi K3 support across built-in providers with progressive (deferred) extension tool activation; xAI login uses a prefilled "Sign in with SuperGrok or X Premium" link and the default xAI model is now Grok 4.5; removed older Grok 3/4 variants from the xAI catalog.

#### hermes-agent v2026.6.19 → v2026.7.7.2

**v2026.7.1** (Hermes Agent v0.18.0, "The Judgment Release") —
- Closed 100% of open P0/P1 issues and PRs (~700 highest-priority items) in a focused clean-sweep.
- Mixture-of-Agents became a first-class selectable model (`moa` provider) showing each reference model's reasoning and live-streaming the aggregator's answer.
- `/goal` completion contracts plus self-verification of coding work against project checks; `/learn` distills reusable skills; `/journey` is a playable timeline of memories/skills; `delegate_task` can fan out background subagents.
- Google Vertex AI provider (auto-refreshing service-account OAuth tokens); gateway scale-to-zero and external drain coordination; first-class coding Projects in the desktop app; a large security hardening round.

**v2026.7.7** (Hermes Agent v0.18.1) — Patch release rolling up ~660 PRs merged since v0.18.0 (Windows installer self-healing, dashboard/gateway fixes, WhatsApp dashboard pairing, MCP/provider fixes, stability work). Full curated notes deferred to v0.19.0.

**v2026.7.7.2** (Hermes Agent v0.18.2) — Same-day patch unpinning the WhatsApp Baileys dependency from a git commit to the published 7.0.0-rc13, making tagged-release Docker builds reliable.

### Changes

- d8463c3 fix: refuse to run from $HOME unless --mount-entire-home is passed (#125)
- d1b955d chore: add mise to check-deps skill + bump eligible dependencies (#124)
- af0debf Pre-build web UI in Docker image (#122)
- 98fc1e0 feat(hermes): add Chromium system deps for Playwright browsers (#129)

## [1.9.1] - 2026-06-27

### Summary

Maintenance release bundling dependency updates and documentation/test improvements. Bumps `gh` to 2.95.0 and `hermes-agent` to v2026.6.19 (Hermes Agent v0.17.0). Removes a fabricated `cp -rn` seed mechanism that was incorrectly documented for the hermes entrypoint, refactors the monolithic e2e test file into focused modules, and adds README documentation for apple/container kernel bootstrap, multi-provider env files, and container runtime resource configuration.

### Dependency Updates

- updated `gh` from `2.94.0` to `2.95.0`
- updated `hermes-agent` from `v2026.6.5` to `v2026.6.19`

### Upstream Release Notes

#### hermes-agent v2026.6.5 → v2026.6.19

**v2026.6.19** (Hermes Agent v0.17.0, "The Reach Release") —
- New messaging channels: iMessage via Photon Spectrum (no Mac relay required), the official WhatsApp Business Cloud API (no bridge process), the Raft agent-network gateway, and SimpleX group support.
- Background/async subagents via `delegate_task(background=true)`, image-to-image editing in `image_generate`, Automation Blueprints, and Cursor's Composer model reachable through an xAI Grok subscription.
- The `memory` tool gained atomic batch operations; the desktop app expanded substantially (subagent watch-windows, installable VS Code themes, composer model selector); the dashboard gained a full profile builder and a rehauled Skills Hub.
- The skill curator no longer spends aux-model budget on routine runs (consolidation is now opt-in); dashboard login was hardened; 300+ issues closed plus a security round.

### Changes

- 372b42e chore: bump gh, hermes-agent, debian digest (#115)
- 6e0d3bc Delete TODO.md
- eb90c58 fix(docs): remove fabricated cp -rn seed mechanism from hermes entrypoint (#112)
- 41bf09f refactor: split monolithic e2e test file into focused modules (#111)
- 7cd7428 docs: add container runtime resource config to README (#109)
- 907426f docs: document apple/container kernel bootstrap and multi-provider env files (#110)

## [1.9.0] - 2026-06-20

### Summary

Adds support for Apple's native `container` CLI as an alternative container runtime on macOS 26 / Apple Silicon. Set `HARNESS_CONTAINER_RUNTIME=apple` to use it. The apple runtime runs OCI images as lightweight Linux microVMs under Apple's Virtualization framework, providing hardware-assisted isolation. The `--security-opt` flags used under Docker are not applied under the apple runtime (each workload has its own guest kernel, so the seccomp profile's host-kernel role is subsumed by the VM boundary); capability restrictions (`--cap-drop=ALL --cap-add=NET_RAW`) remain enforced. Image verification (cosign + SLSA provenance) works identically under both runtimes.

### Changes

- 6adb030 feat: implement HARNESS_CONTAINER_RUNTIME for apple/container support (#108)
- 4a1e56b rfc: HARNESS_CONTAINER_RUNTIME for apple/container support (#107)

## [1.8.6] - 2026-06-20

### Summary

Fixes zensical documentation build failures and adds a PR docs build check to CI. Improves documentation for git/gh auth configuration persistence (including gh PAT login), documents `.config` and mise data/state persistence in deployment guides, adds `HARNESS_CLOUD_MODE=1` to all deployment guides for cloud mode consistency, and fixes `.hermes-openrouter` references to `.hermes`. Also disables in-container self-update notifications for all agents to reduce noise.

### Changes

- ec7dd17 fix(docs): fix zensical build failure and add PR docs build check (#106)
- bdafa75 feat: persist git/gh auth config and document gh PAT login (#105)
- 5c05670 docs: persist .config and mise data/state in deploy guides (#104)
- c77eef5 fix: disable in-container self-update notifications (#100) (#101)
- a070a6e docs: add HARNESS_CLOUD_MODE=1 to all deployment guides (#103)
- 0bec7c2 fix(docs): replace .hermes-openrouter with .hermes (#102)

## [1.8.5] - 2026-06-19

### Summary

Adds project-level config persistence — the container's `~/.config` is now persisted at the project (cwd) level and shared across every agent working in the same project, so tool configs (e.g. jj) survive across interactive runs with no new flags. Also removes `sudo` and sudoers from the base image and renames the package scope from `capotej` to `boldblackai` across the repo. Bundled agent bumps: `pi-coding-agent` 0.73.1 → 0.79.2 (now published under the `@earendil-works` scope) and `hermes-agent` v2026.5.29.2 → v2026.6.5.

### Dependency Updates

- updated `pi-coding-agent` from `@mariozechner/pi-coding-agent@0.73.1` to `@earendil-works/pi-coding-agent@0.79.2`
- updated `hermes-agent` from `v2026.5.29.2` to `v2026.6.5`
- updated `gh` from `2.93.0` to `2.94.0`
- updated `uv` from `0.11.16` to `0.11.19`
- updated `cosign` from `3.0.6` to `3.1.1`

### Upstream Release Notes

#### @earendil-works/pi-coding-agent 0.73.1 → 0.79.2

**v0.74.0** — Repository and package references moved to `earendil-works/pi-mono` and the `@earendil-works/*` scopes.
**v0.74.1** — Image generation support (OpenRouter), Together AI provider, Windows ARM64 binaries, and improved markdown/terminal rendering.
**v0.74.2** — Rescue release telling Node 20 users to upgrade Node; `pi update` self-update commands now pass `--ignore-scripts`.
**v0.75.0** — **Breaking:** raised minimum Node.js to 22.19.0; system prompt/context boundaries now use explicit XML tags; user-scoped npm pi packages install under `~/.pi/agent/npm/`; undici 8 dispatcher replaces the custom fetch override.
**v0.75.1** — Fixed config selectors, Anthropic/Bedrock/Azure provider compat, and OpenCode Go Kimi reasoning replay; removed non-working Codex fast model variants.
**v0.75.2** — Fixed Bun-compiled binaries, Xiaomi MiMo thinking-mode replay, and Windows external-editor / npm self-update handoffs.
**v0.75.3** — Fixed undici 8 HTTP/2 destroyed-session crashes by reverting to HTTP/1.1-only fetch dispatcher behavior.
**v0.75.4** — Hardened npm install/release path (generated shrinkwrap, lifecycle-script allowlists, isolated install smoke tests); interactive update notes after `pi update`.
**v0.75.5** — Collapsed read tool cards, async file tools (Windows), `compat.forceAdaptiveThinking` for custom Anthropic providers, more reliable git-pinned package updates.
**v0.76.0** — `--session-id` for exact project-local session IDs, `excludeFromContext` for RPC bash, configurable provider retries/timeouts, better terminal editing (Apple Terminal, Windows/JetBrains detection, Unicode word navigation).
**v0.77.0** — Claude Opus 4.8 support, `--exclude-tools`/`-xt` selective tool disablement, headless Codex subscription device-code login, `streamingBehavior` on extension input events.
**v0.78.0** — `--name`/`-n` session naming, OSC 8 `file://` hyperlinks in file-tool titles, exported `convertToPng`/`parseArgs` for extension authors.
**v0.78.1** — Ant Ling + NVIDIA NIM providers, MiniMax-M3 support, `ctx.mode` and `ctx.getSystemPromptOptions()` for extensions.
**v0.79.0** — Project trust gating for local inputs (with `--approve`/`--no-approve`), extension-controlled trust decisions, prompt-cache hit rate in the footer, richer SDK/RPC extension exports.
**v0.79.1** — Claude Fable 5, prompt-template default arguments (`${1:-7}`), `defaultProjectTrust` setting, extension autocomplete trigger characters.
**v0.79.2** — Clearer Bedrock data-retention validation guidance; experimental first-time setup flow (`PI_EXPERIMENTAL=1`); project-trust and OpenAI/Azure context-window fixes.

#### hermes-agent v2026.5.29.2 → v2026.6.5

**v2026.6.5** (v0.16.0, "The Surface Release") — New native desktop app (macOS/Linux/Windows) with in-app self-update, drag-and-drop files, an inline model picker, and concurrent multi-profile sessions that can connect to remote Hermes gateways over OAuth or username/password. The web dashboard grew a full admin panel (messaging channels, MCP catalog, credentials, webhooks, memory, pluggable OIDC / username-password login), plus a "Quick Setup via Nous Portal" first-run path. Also: trimmed default skill set, NVIDIA/skills as a trusted tap, fuzzy model picker everywhere (desktop/web/TUI/CLI), and `/undo [N]` across all interfaces. Rode along with 2 P0 + 62 P1 closures and a security round (Starlette CVE pin, SSRF off-loop hardening, subprocess credential stripping).

### Changes

- 43e549f Remove sudo and sudoers from base image (#89) (#99)
- 62fa2e0 feat: persist container ~/.config at the project (cwd) level (#94)
- 8f321fe chore: rename capotej → boldblackai across repo (#98)
- 8221e88 chore: bump gh, cosign, uv, hermes-agent (#97)
- d8e8fb8 Update references to bb site (#95)

## [1.8.4] - 2026-06-07

### Summary

Adds AWS Bedrock support to the hermes variant by enabling the `bedrock` extra in the hermes-agent installation.

### Dependency Updates

- added `bedrock` extra to hermes-agent installation

### Changes

- 2d86507 Add bedrock to hermes-agent extras (#93)

## [1.8.3] - 2026-06-05

### Summary

Bumps the GitHub CLI (`gh`) to 2.93.0 and hermes-agent to v2026.5.29.2. The hermes-agent update brings the full v0.15.x release series — a major refactor that collapses the core agent loop by 76%, adds a kanban multi-agent platform with swarm topology, dramatically improves cold-start performance, adds Bitwarden Secrets Manager integration, an interactive MCP catalog picker, and fixes a dashboard infinite-reload loop in Docker loopback mode.

### Dependency Updates

- updated `gh` from 2.92.0 to 2.93.0
- updated hermes-agent from v2026.5.16 to v2026.5.29.2

### Upstream Release Notes

#### hermes-agent v2026.5.16 → v2026.5.29.2

**v2026.5.28** — The Velocity Release (1,302 commits, 747 PRs). Core `run_agent.py` reduced from 16K to 3.8K lines (-76%). Kanban grew into a full multi-agent platform with swarm topology, orchestrator auto-decomposition, per-task model overrides, scheduled tasks, and worktree-per-task. Cold-start perf improved: another second shaved, 47% fewer per-conversation function calls. `session_search` is 4,500× faster. Bitwarden Secrets Manager replaces per-provider API keys. Skill bundles, interactive MCP catalog picker, Ink TUI multi-session orchestrator. Two new image_gen providers (Krea 2, FAL). xAI deep integration (Web Search plugin, natural TTS, base_url leak guard). 15 P0 + 65 P1 fixes.

**v2026.5.29** — Hotfix for v0.15.0. Dashboard infinite-reload loop in loopback/Docker mode fixed. Docker `--insecure` is now an explicit env opt-in (`HERMES_DASHBOARD_INSECURE=1`). MCP bare command resolution fixed for Docker. Kanban worker SIGTERM fix. Full skills.sh catalog (858 → 19,932 entries). Hindsight narrowed to observation-only.

**v2026.5.29.2** — Packaging fix: bundled `plugin.yaml` manifests now shipped in wheel and sdist.

### Changes

- c0cbe30 chore: bump gh 2.92.0 -> 2.93.0 and hermes-agent v2026.5.16 -> v2026.5.29.2 (#91)

## [1.8.2] - 2026-06-01

### Summary

Adds context file mounting — `~/.agents/AGENTS.md` and `~/.claude/CLAUDE.md` are now automatically bind-mounted into the agent's context directory so cross-agent rules apply inside the container. Disable with `--no-context-files` (or `-nc`). Adds `openssh-client` to the base image and `libolm-dev` with the `matrix` extra to the hermes variant, enabling Matrix protocol support. Also includes a documentation website (GitHub Pages) and AWS deployment guide for hermes claws.

### Changes

- d0b2f9e feat: add libolm-dev to hermes Docker image and matrix extra (#88)
- 233fda2 feat: mount global ~/.agents/AGENTS.md into agent context path (#85) (#86)
- e60c9ae feat: add openssh-client to base image (#87)
- bae55fd docs: add AWS deployment guide for hermes claw (#71)
- df8abd3 fix(docs): nav paths relative to docs_dir, not project root (#84)
- 8d2e9eb chore: pin all GitHub Actions by full commit SHA (#83)
- bffffbf docs: mark documentation website RFC as Implemented (#82)
- 2c6bce6 fix(docs): use uv tool install and add PR preview deployments (#81)
- f85a3ed docs: add Zensical documentation website with GitHub Pages deployment (#80)
- 23221be docs: add RFC format note and propose documentation website (#76)

## [1.8.1] - 2026-05-25

### Summary

Introduces cloud/local mode (`HARNESS_CLOUD_MODE`) — passing `--env-file` now automatically switches agents to cloud mode where they auto-detect providers from API keys in the file, instead of hardcoding OpenRouter. Use `--local` to force local mode even with `--env-file` (e.g. `harness -e .env --local -p "..."`). Simplifies hermes persistence to a single directory and scopes npm persistence to the pi adapter. Adds multi-provider configs for opencode (Anthropic, Google, OpenAI, ZAI).

### Changes

- 967f1c2 scope mount to pi adapter, biome fixes for pi-lens (#79)
- e1ace6c stop hardcoding openrouter, start multi provider support (#78)

## [1.8.0] - 2026-05-24

### Summary

Migrates persistence to XDG data directories with per-agent `mise` support — interactive runs now store agent state, tool data, and trust settings under `$XDG_DATA_HOME/harness/<project>/<agent>/`. Ensures `npm install -g` works correctly for the harness user by configuring a non-root prefix. Bumps all three agent dependencies: pi 0.71.1 → 0.73.1, opencode 1.14.31 → 1.15.10, and hermes v2026.5.7 → v2026.5.16 (major v0.14.0 "Foundation" release).

### Dependency Updates
- updated `debian:stable-slim` base image digest
- updated `@mariozechner/pi-coding-agent` from 0.71.1 to 0.73.1
- updated `opencode-ai` from 1.14.31 to 1.15.10
- updated `uv` from 0.11.8 to 0.11.16
- updated `hermes-agent` from v2026.5.7 to v2026.5.16
- updated `python-telegram-bot` from 22.7 to 22.6
- removed `croniter` from hermes image

### Upstream Release Notes

#### @mariozechner/pi-coding-agent 0.71.1 → 0.73.1

**v0.72.0** — **Breaking:** replaced `compat.reasoningEffortMap` with model-level `thinkingLevelMap`. Added Xiaomi MiMo Token Plan provider (`XIAOMI_API_KEY`), custom provider base URL overrides via `pi.registerProvider()`, and post-turn stop callback (`shouldStopAfterTurn`). Fixed self-update detection.

**v0.73.0** — **Breaking:** switched built-in `xiaomi` provider from Token Plan AMS to API billing endpoint; Token Plan users should switch to `xiaomi-token-plan-{cn,ams,sgp}`. Added incremental bash output streaming (output appears while commands run) and compact `read` rendering. Fixed OpenAI Codex WebSocket transport fallback and session lifecycle, Bedrock Claude Opus 4.7 `xhigh` thinking, and Qwen 3.5/3.6 model metadata.

**v0.73.1** — Added self-update support for the upcoming npm scope migration (`@mariozechner` → `@earendil-works`), interactive OAuth login selection for providers, and JSONC-style `models.json` parsing (comments and trailing commas). Fixed `pi -p` treating YAML frontmatter prompts as flags, `/copy` on Wayland compositors, HTML session exports stripping skill wrapper XML, and Codex OAuth refresh errors.

#### opencode-ai 1.14.31 → 1.15.10

**v1.14.32–v1.14.35** — Shell mode prompt editing restored; PTY connection tickets for authenticated terminal websockets; v2 session failure events; improved shell command handling (Bash/PowerShell/cmd); many HTTP API fixes (structured errors, CORS, pagination, basic auth); diff patch boundary preservation fix.

**v1.14.37** — Canceling a task now cancels child subtask sessions; improved v2 session rendering; added session warping to another workspace.

**v1.14.38–v1.14.40** — Desktop trusts system CA certs and `HTTP_PROXY` env vars; support for `.well-known/opencode` remote config files; fixed Cloudflare AI Gateway, Mistral Medium 3.5 variants, and server-overload auto-retries.

**v1.14.41–v1.14.42** — **Added Scout agent** for repo research/docs/dependency inspection; added workspace sync and interactive split-footer mode for `opencode run`; session warping carries uncommitted file changes; moved desktop local server to separate utility process.

**v1.14.43–v1.14.45** — Fixed provider API responses with non-JSON auth loader; included tool image attachments in ACP updates; fixed read tool permissions for worktree-relative paths; SDK `throwOnError` throws real `Error` with server message.

**v1.14.46** — Added built-in `customize-opencode` skill; **fixed Plan Mode security bypass** where subagents could ignore parent deny rules; fixed MCP tool discovery with broken `outputSchema`.

**v1.14.47–v1.14.48** — Restored TUI prompt editing keybindings; model changes persist across sessions; Scout materializes configured reference repos; image attachments preserved as-is (reverted auto-resizing).

**v1.14.49** — **Major:** Added v2 model/provider listing API; DigitalOcean OAuth + Inference Router support; auto-creates `opencode.jsonc` with full schema; `@mentions` autocomplete in prompts; pinned recent sessions + quick slots in TUI.

**v1.14.50–v1.14.51** — **Added experimental background subagents** for concurrent task execution; fixed HTTP event streams closing after initial connect; restored markdown rendering for session output; LiteLLM now requires v1.85.0-rc.2+.

**v1.15.0** — Added Effect-based core event system for more complete event delivery; fixed versioned event projector lookups; desktop auto-hides menu bar on Linux/Windows.

**v1.15.1** — Added collapsed thinking view (expandable inline); pinned sessions with quick-switch slots; fixed npm native binary recovery; fixed multiline `@` mentions; preserved custom tool Zod schema metadata.

**v1.15.10** — Restored legacy production desktop flows for opening projects and starting sessions.

#### hermes-agent v2026.5.7 → v2026.5.16

**v2026.5.16** — Major v0.14.0 "Foundation" release: xAI Grok via SuperGrok OAuth with grok-4.3 at 1M context window; OpenAI-compatible local proxy (`hermes proxy`) turns any OAuth provider into an endpoint for Codex/Aider/Cline/Continue; `x_search` first-class X (Twitter) search tool; Microsoft Teams end-to-end; massive debloating wave (heavy backends lazy-install on first use, `pip install hermes-agent` works from PyPI); cross-session 1-hour Claude prompt caching; 180x faster `browser_console` evaluations; ~19 seconds off cold-start launch; two new messaging platforms (LINE + SimpleX Chat, total 22); `/handoff` live session transfer; native button UI for `clarify` on Telegram/Discord; Discord channel history backfill; LSP semantic diagnostics on every write; unified pluggable `video_generate`; `computer_use` cua-driver backend for non-Anthropic models; native Windows beta; 808 commits, 633 merged PRs, 12 P0 + 50 P1 closures.

### Changes
- 1bd5625 update dependencies
- 912cf73 npm install -g (used by pi install) is now owned by harness (#74)
- 15f8a1d feat: XDG persistence migration with per-agent mise support (#73)
- 4ed42cb XDG data home agent persistence migration (#72)

## [1.7.0] - 2026-05-16

### Summary
Adds warning when unrecognized CLI flags are passed, blocks AF_ALG socket creation via seccomp profile for security, adds git to the base image for mise compatibility, bumps hermes-agent to v2026.5.7 (Tenacity Release with multi-agent kanban, `/goal` lock, and security fixes), expands test coverage with code coverage metrics, and consolidates v1.6.x test coverage.

### Dependency Updates
- updated `hermes-agent` from v2026.4.30 to v2026.5.7

### Upstream Release Notes

#### hermes-agent v2026.4.30 → v2026.5.7

**v2026.5.7** — Major v0.13.0 "Tenacity" release: multi-agent Kanban with durable board, heartbeats, reclaim, zombie detection, and hallucination gate; `/goal` lock keeps the agent on-task across turns; security wave closes 8 P0s (redaction ON by default, Discord role-allowlists guild-scoped, WhatsApp rejects strangers by default, TOCTOU fixes across auth.json and MCP OAuth); Google Chat as 20th messaging platform; gateway auto-resumes interrupted sessions after restart; checkmarks v2 rewrite for real pruning; providers become a pluggable surface; i18n support for 7 locales.

### Changes
- a76c6e2 security: block AF_ALG socket creation via seccomp profile (#60)
- 6b9a0d2 feat: warn on unrecognized CLI flags (#66)
- 22a4d5b fix: add git to base image for mise compatibility (#67)
- 041b706 deps: bump hermes-agent v2026.4.30 → v2026.5.7 (#59)
- 191d601 ci: add code coverage metrics to test suite (#56)
- 434d2d4 test: v1.7.x coverage bump (8 distinct CLI invariants) (#58)
- 8b30d3b test: consolidated v1.6.x coverage (tracks N-T, replaces #49-#55) (#57)
- e773746 Change CODEOWNERS to assign ownership to @capotej
- 97a7156 test(volumes): --volumes is forwarded alongside interactive persistence mounts (#48)
- a27b6f1 test(volumes): --volumes is forwarded alongside --file mode (both mounts present) (#47)

## [1.6.4] - 2026-05-04

### Summary
Fixes ownership of the `/opt/hermes-agent` directory to the harness user, ensuring proper permissions for the hermes-agent installation.

### Changes
- 50813d6 make harness the owner of /opt/hermes-agent

## [1.6.3] - 2026-05-04

### Summary
Adds `web` and `pty` extras to hermes-agent installation, enabling additional hermes functionality for web-based operations and PTY interactions.

### Changes
- 35d96c2 add web,pty extras to hermes

## [1.6.2] - 2026-05-03

### Summary
Adds the [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) to the hermes image by installing `hermes-agent[mcp]` instead of `hermes-agent`, enabling the hermes agent to connect to MCP servers.

### Changes
- 915acc8 feat: add MCP SDK to hermes image (#46)

## [1.6.1] - 2026-05-03

### Summary
Adds `--volumes` (`-v`) flag for mounting additional volumes into the container (e.g. `harness -v /path/to/data:/data -p "analyze the CSV"`). Adds [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) to the hermes image for local speech-to-text. Fixes the logo rendering on mobile Safari (dark mode) and removes a duplicate logo element. Adds `mise.toml` for system linter tooling.

### Dependency Updates
- added `faster-whisper` 1.2.1 to hermes image

### Changes
- 9950893 add -v/--volume to README
- 2643dd4 feat: add --volumes flag for custom volume mounts (#43)
- 45f2079 chore: add mise.toml for system linter tooling (#44)
- dd0f663 feat: add faster-whisper to hermes image for local STT (#41)
- dd208cb fix: remove picture element causing double logo render (#40)
- 0c2748d fix: render logo-dark in dark mode on mobile Safari (#39)
- 83e9097 smaller logo
- 54ab0a0 update logo

## [1.6.0] - 2026-05-02

### Summary
Automatically mounts user skills directories (`~/.agents/skills`, `~/.claude/skills`) into the container so agents can discover custom skills — disable with `harness --no-skills`. Adds Kubernetes deployment instructions for hermes. Unifies the 7-day dependency cooldown enforcement across the check-deps skill, AGENTS.md, and the hermes Dockerfile (`--exclude-newer`). Fixes an npm config warning caused by the deprecated `minimumReleaseAge` setting. Expands the e2e test suite with coverage for ephemeral persistence, whitespace stdin handling, and interactive run mount materialization.

### Changes
- 5cb9773 feat: mount user skills directories into container, add --no-skills flag (#37)
- 385b43f fix lint
- 78f0103 refactor: unify 7-day dependency cooldown across check-deps skill, AGENTS.md, and Dockerfile
- 7879c1d fix: npm warns about unknown config minimumReleaseAge (#34)
- 7efa1d1 fix: resolve markdownlint errors in .agents/skills and AGENTS.md (#35)
- 02fae8d de-CLAUDE.md
- 10f2865 test(opencode): interactive run materializes all 3 persistence dirs and mounts (#30)
- 21235cc chore: update dependencies (#32)
- 84ddbe5 test(cli): whitespace-only piped stdin takes no-prompt branch (pi has no -p) (#31)
- 50976dc test(cli): --ephemeral overrides interactive PTY (no .harness/, no persist mount) (#29)
- 31792d4 test(pi): no-prompt branch with --model emits --provider ollama (no -p) (#22)
- 9bb52cf add k8s deploy instructions
- b30ac7c docs(readme): add "Customizing the claw — don't extend the image" section (#28)

### Dependency Updates
- updated `gh` from 2.91.0 to 2.92.0
- updated `@mariozechner/pi-coding-agent` from 0.70.2 to 0.71.1
- updated `opencode-ai` from 1.14.25 to 1.14.31
- updated `uv` from 0.11.7 to 0.11.8
- updated `hermes-agent` from v2026.4.23 to v2026.4.30

### Upstream Release Notes

#### @mariozechner/pi-coding-agent 0.70.2 → 0.71.1

**v0.70.3** — Added `pi update` self-update support and Azure Cognitive Services endpoint for OpenAI; extension-controlled working row visibility via `ctx.ui.setWorkingVisible()`; fixed Kitty keyboard protocol duplicate characters, Bun sandboxed startup, symlinked package duplication, and Bedrock prompt-caching for inference profile ARNs.

**v0.70.4** — Fixed packaged `pi` startup failure from session selector importing a source-only utility path.

**v0.70.5** — Fixed HTML export preserving ANSI-renderer trailing padding as extra blank wrapped lines.

**v0.70.6** — Added Cloudflare Workers AI as a built-in provider; improved update checks with `pi.dev` and `pi/<version>` user agent; fixed HTML export to escape embedded image data preventing markup injection; fixed Bun package manager startup and `pi update --self` detection on Windows.

**v0.71.0** — **Breaking:** removed Google Gemini CLI and Antigravity providers. Added Cloudflare AI Gateway, Moonshot AI, and Mistral Medium 3.5 providers. Extension APIs can replace finalized messages, wrap custom editor factories, and observe thinking level changes. Added `PI_CODING_AGENT_SESSION_DIR` env var. Fixed `grep`/`find` tool argument injection for flag-like patterns, DeepSeek V4 Flash `xhigh` thinking support, and numerous Windows/WSL/Vertex fixes.

**v0.71.1** — Added `websocket-cached` transport option for OpenAI Codex provider, keeping the same WebSocket open and sending only new conversation items after the first request.

#### opencode-ai 1.14.25 → 1.14.31

**v1.14.26** — Fixed config parsing to preserve permission rule order; fixed OpenRouter DeepSeek reasoning output; added Zed editor selection support.

**v1.14.27** — Added configurable default shell for terminals and agent commands; reduced terminal noise during TUI workspace creation.

**v1.14.28** — Fixed `opencode upgrade` failing for bun installs outside a package.json directory.

**v1.14.29** — Sessions keep relative workspace paths; Moonshot/Kimi tool schemas sanitized; shell cancellations finish cleanly; tool streaming defaults off for non-Anthropic models; LSP tool forwards workspace symbol query; Zed context polling stays responsive.

**v1.14.30** — Fixed missing Desktop sessions from path mismatches; added Mistral Medium 3.5 with reasoning; instruction precedence now applies global before project/skill; session filtering by current path with setting to show whole project; reduced memory growth in long-running bash tool usage.

**v1.14.31** — Azure setup prompts for resource name; task child sessions preserve parent `external_dir` and deny permissions; invalid remote MCP URLs fail with clear error.

#### hermes-agent v2026.4.23 → v2026.4.30

**v2026.4.30** — Major v0.12.0 "Curator" release: autonomous background Curator grades/prunes/consolidates skill library on a cron schedule; self-improvement loop upgraded to class-first rubric-based grading with proper runtime inheritance. Four new inference providers (GMI Cloud, Azure AI Foundry, MiniMax OAuth, Tencent Tokenhub), LM Studio promoted to first-class provider, Microsoft Teams as 19th messaging platform via plugin architecture, native Spotify tools and Google Meet plugin. ComfyUI v5 and TouchDesigner-MCP bundled by default. `hermes -z` one-shot mode added. TUI cold start cut ~57%. Secret redaction now off by default.

## [1.5.0] - 2026-04-26

### Summary
Adds `mise` (polyglot version manager) to the base image for in-container language toolchain management, and introduces `tini` as PID 1 across all container variants for proper zombie process reaping and signal forwarding. Expands the e2e test suite with coverage for persistence behavior, `--env-file` forwarding across agents, and CLI documentation completeness.

### Changes
- 0710e24 test(hermes): no -m and no -p emits exactly ['hermes','chat'] (#25)
- ca2f1e3 test(opencode): --env-file is forwarded for non-pi adapters too (#24)
- 4783fa7 test(persist): interactive run without --ephemeral creates .harness/<agent>/ persistence dir (#23)
- 8c0e81b feat: add mise as polyglot version manager to base image (#26)
- a4fd46a test(pi): inverse case  env-file + -m omits --provider ollama (#20)
- 984598e chore: add tini as PID 1 for zombie reaping and signal forwarding (#19)
- d07b6a4 test(cli): assert HARNESS_IMAGE_TAG is documented in --help (#21)

### Dependency Updates
- added `mise` v2026.4.23 (polyglot version manager)
- added `tini` v0.19.0 (PID 1 init process)

## [1.4.6] - 2026-04-26

### Summary
Fixes `--provider ollama` not being forwarded when `-m` is used without `-e` in local mode (e.g. `harness -m "qwen/qwen3.5-9b" -p "..."` now correctly routes to Ollama). Switches the uv cooldown enforcement from a `uv.toml` config file to `--exclude-newer` passed directly to `uv pip install` at image build time — more reliable and removes a footgun. Adds a comprehensive e2e test suite for the CLI. Also ships major upstream updates across all three agents and core dependency bumps.

### Changes
- 7852c25 test: update --model test to reflect --provider ollama in local mode
- f1de7e0 docs: clarify -m model flag works in local mode with HuggingFace IDs
- 359ae3f fix(pi): pass --provider ollama when -m is used without -e
- 7003bf5 fix markdownlint
- 9cb0a47 readme
- b812f27 test: comprehensive e2e tests for the harness CLI (#5)
- bae109d fix: enforce uv cooldown via --exclude-newer flag and add hermes cooldown to check-deps skill (#18)

### Dependency Updates
- updated `debian:stable-slim` base image digest
- updated `pnpm` from 10.33.0 to 10.33.2
- updated `@mariozechner/pi-coding-agent` from 0.67.68 to 0.70.2
- updated `opencode-ai` from 1.14.18 to 1.14.25
- updated `uv` from 0.11.6 to 0.11.7
- updated `hermes-agent` from v2026.4.16 to v2026.4.23

### Upstream Release Notes

#### @mariozechner/pi-coding-agent 0.67.68 → 0.70.2

**v0.68.0** — Configurable streaming working indicator for extensions via `ctx.ui.setWorkingIndicator()`; `before_agent_start` now exposes `systemPromptOptions` so extensions can inspect structured system-prompt inputs.

**v0.68.1** — Added Fireworks provider support with `FIREWORKS_API_KEY` auth and default model `accounts/fireworks/models/kimi-k2p6`; configurable inline tool image width via `terminal.imageWidthCells`.

**v0.69.0** — TypeBox 1.x migration for extensions and SDK; TypeBox-native tool argument validation now works in eval-restricted runtimes (e.g. Cloudflare Workers); stacked extension autocomplete providers via `ctx.ui.addAutocompleteProvider()`.

**v0.70.0** — Searchable fuzzy-filter login flow for `/login` provider selector; GPT-5.5 Codex support (`openai-codex/gpt-5.5`) with `xhigh` reasoning; OSC 9;4 terminal progress indicators are now opt-in.

**v0.70.1** — DeepSeek provider support with V4 Flash/Pro models and `DEEPSEEK_API_KEY`; provider request timeout/retry controls via `retry.provider.{timeoutMs,maxRetries,maxRetryDelayMs}`.

**v0.70.2** — Fixed provider retry/timeout forwarding to omit undefined fields, avoiding downstream SDK validation errors (e.g. `timeout must be an integer`).

#### opencode-ai 1.14.18 → 1.14.25

**v1.14.19** — Fixed circular session schema startup failure; renamed `compaction` setting to `preserve_recent_tokens`; preserved concurrent edits to the same file; added NVIDIA as a built-in provider.

**v1.14.20** — Fixed system theme regression in TUI; added `GET /config` to the experimental HTTP API; fixed permission replies for remote workspaces.

**v1.14.21** — LSP pull diagnostics support (C#, Kotlin); improved session compaction for long threads; C# support switched to Roslyn Language Server; Mistral high-reasoning variant.

**v1.14.22** — Respects `.npmrc` settings during npm installs; projects can store persistent custom icon overrides.

**v1.14.23** — Respects custom `.npmrc` registry settings for package version checks; TUI renders all non-synthetic text in user messages.

**v1.14.24** — Fixed DeepSeek assistant messages (reasoning always included); experimental HTTP API endpoints for MCP server status and file listing/reading.

**v1.14.25** — Fixed permission config to preserve rule order with full IntelliSense for tool permission keys; LSP permission prompts include operation, file, and cursor position; shell commands keep correct working directory after login shell startup; Roslyn LSP support for Razor and `.cshtml` files.

#### hermes-agent v2026.4.16 → v2026.4.23

**v2026.4.23** — Major v0.11.0 release: new Ink-based TUI (`hermes --tui`), native AWS Bedrock support, pluggable transport architecture, 17th messaging platform (QQBot), GPT-5.5 via Codex OAuth, and dramatically expanded plugin surface. Covers ~2 weeks of work (1,556 commits, 761 PRs).

## [1.4.5] - 2026-04-25

### Summary
Enforces a 1-week cooldown on dependency resolution inside the container for both pnpm (`minimumReleaseAge=10080`) and uv (`exclude-newer = "7 days"`), rejecting packages published within the last 7 days to mitigate supply-chain attacks. Also expands the `harness` user's passwordless sudo access to include `dpkg`, surfaces `HARNESS_IMAGE_TAG` in `--help` output, and documents fly.io deployment with `GH_TOKEN`.

### Changes
- 093de49 feat: add dpkg to passwordless sudoers for harness user (#17)
- e064316 feat: enforce 1-week dependency cooldown on pnpm and uv (#15)
- d50d603 docs: surface HARNESS_IMAGE_TAG in --help output (#13)
- 879c9f9 docs: add GH_TOKEN to fly.io setup (#14)
- b1914b3 bump github actions

## [1.4.4] - 2026-04-25

### Summary
Installs `gh` CLI v2.91.0 in the base image with checksum verification for both amd64 and arm64. The PR workflow now builds and tests both architectures natively. Also fixes cosign to exit with an error (rather than a warning) when not installed, and adds fly.io deployment instructions for hermes to the README.

### Dependency Updates
- added `gh` 2.91.0 to base image

### Changes
- f3f4982 Merge pull request #11 from hermclaw/issue/gh-cosign
- 72d45b1 fix: pass TARGETARCH in Makefile for correct gh binary
- 0d967c4 fix: use native arm runner instead of QEMU emulation
- b1c502b feat: build and test both amd64 and arm64 in PR workflow
- 69bf594 fix: rename tarball to match checksum filename for sha256sum -c
- a96ee1e fix: replace cosign verification with checksum verification for gh install
- e201b8b feat: install pinned gh with cosign verification in base Dockerfile
- 090d03e Merge pull request #12 from capotej/pr-build-check
- fddf0b4 add PR build check workflow
- 6a1b803 Merge pull request #9 from hermclaw/fix-cosign-exit-on-missing
- 66d2f08 fix: exit with error if cosign not installed instead of warning
- ae03b50 fix /restart hermes gateway command on fly.io containers
- 4b5eb6f bump github actions
- 3d69bf5 add instructions about deploying hermes to fly.io

## [1.4.3] - 2026-04-23

### Summary
Adds `croniter 6.2.2` to the hermes agent image, enabling cron expression parsing and scheduling support within the hermes environment.

### Dependency Updates
- added `croniter` 6.2.2 to hermes image

### Changes
- e139a0e add croniter to hermes

## [1.4.2] - 2026-04-22

### Summary
Adds `python-telegram-bot 22.7` to the hermes agent image, enabling Telegram bot integration support within the hermes environment.

### Dependency Updates
- added `python-telegram-bot` 22.7 to hermes image

### Changes
- 7a97c2f add python-telegram-bot=22.7 to hermes

## [1.4.1] - 2026-04-22

### Summary
Housekeeping release: adds a LICENSE file, pins the pnpm package manager version, and switches the Dockerfile shell to bash with pipefail — fixing `mkdir` brace expansion failures in the hermes image.

### Changes
- 1c3661a set pnpm version
- 8b9c442 pnpm lint
- eea47e1 add LICENSE

## [1.4.0] - 2026-04-22

### Summary
Interactive runs now persist agent state by default: harness creates a `.harness/<agent>/` directory in your working directory and bind-mounts it into the container, letting agents resume sessions and retain memories across invocations. One-shot runs (`-p "..."` or piped stdin) remain implicitly ephemeral; use `--ephemeral` to force-disable persistence for interactive runs. Image signature verification results are now cached per digest to avoid redundant cosign checks on repeated invocations.

### Changes
- fef0a0b cache the image signature verification per digest
- 2f56b75 persist agent data by default in .harness, --ephemeral to opt out

## [1.3.3] - 2026-04-21

### Summary
The hermes sub-image now includes [`tirith`](https://github.com/sheeki03/tirith) v0.2.12 and adds full cosign attestation verification for the `uv` binary at build time. The README documents the `HARNESS_IMAGE_TAG` environment variable for overriding the Docker image tag.

### Dependency Updates
- added `tirith` 0.2.12 to hermes image
- added cosign attestation verification for `uv` in hermes image

### Changes
- fcb209d verify uv and cosign
- ae3c7da install tirith in hermes image

## [1.3.2] - 2026-04-19

### Summary
The container now runs as a dedicated non-root `harness` user for improved security. Image verification is enabled by default on startup (skip with `--no-verify`). Updated `@mariozechner/pi-coding-agent` to 0.67.68.

### Dependency Updates
- updated `@mariozechner/pi-coding-agent` from 0.66.1 to 0.67.68

### Changes
- 870b6c3 rootless containers
- 4c746f6 get rid of --sh
- 80bb880 enable verification by default
- 008cf77 prepare for immutable releases

## [1.3.1] - 2026-04-19

### Summary
Adds build provenance attestation to the CI pipeline for improved supply chain security.

### Changes
- ad23df9 attest build provenance

## [1.3.0] - 2026-04-19

### Summary
Agent backends (`opencode`, `hermes`) have been split into separate sub-images that are dynamically loaded at runtime, keeping the base image lean. Image verification on startup is now supported (experimental, opt-in via `HARNESS_VERIFY=1`): harness checks that the container image was signed by the official CI workflow using cosign before running. Disable with `--no-verify`.

### Dependency Updates
- removed `opencode-ai@1.14.18` from base image (moved to subimage)
- removed `uv@0.11.6` and `hermes-agent@v2026.4.16` from base image (moved to subimage)

### Changes
- 5b7c4fe split up agents into subimages, dynamically load them
- 79542cd verify harness image on start (experimental, behind HARNESS_VERIFY=1)

## [1.2.0] - 2026-04-19

### Summary
Adds the [`hermes`](https://github.com/NousResearch/hermes-agent) agent backend by NousResearch. The Docker image was also optimized by removing unused packages (`vim`, `iputils-ping`) and cleaning up caches to reduce image size.

### Dependency Updates
- added `uv` 0.11.6 (build stage for hermes installation)
- added `hermes-agent` v2026.4.16

### Changes
- 63fef70 pin harness image
- f385189 hermes agent
- d021dbc optimize docker image, skill to analyze image
- be45fa8 /release skill

## [1.1.1] - 2026-04-19

### Changes
- 40398b2 support -f/--file to mount only a single file
- 76cd70d context files
- 0951e12 pin image and bump to 1.1.0
- 95cdb21 opencode adapter
- 84aaebe switch to adapters for agents
- bee4bfe switch to typescript
- cdd8240 bump package version
- 73ce639 readme
- 32ddde2 readme
- 0b5094e readme
- 3dd38fc update logo to be transparent
- 5249065 readme updates
- bf1006b update README with logo, update package visibility in package.json
