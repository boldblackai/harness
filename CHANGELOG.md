# Changelog

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
