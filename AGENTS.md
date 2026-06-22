# harness

## Project Overview

**Harness** is a portable containerized environment for running coding agents. See README.md for more project details.

**Documentation website:** Built with [Zensical](https://zensical.org) from `docs/`. Config in `zensical.toml`. Deploys to GitHub Pages via `.github/workflows/docs.yml`, which also runs a build-only check on PRs that touch `docs/`, `zensical.toml`, or the workflow itself (so doc build failures are caught before merge). Build locally with `pip install zensical && zensical build --clean` (CI uses `uv tool install zensical==0.0.43`).

## Commands

```bash
pnpm build            # Compile TypeScript → bin/harness.js
make build            # Same via Makefile
make image            # Build all Docker images (base + opencode + hermes variants)
make image-base       # Build base image only
make image-opencode   # Build opencode variant
make image-hermes     # Build hermes variant
pnpm link --global    # Make `harness` CLI available globally for local testing
pnpm lint             # Run all linters (biome, markdownlint, shellcheck, hadolint, actionlint)
pnpm format           # Auto-format with Biome
pnpm test:e2e         # Run e2e CLI tests (uses a docker shim, no real docker needed)
```

System linters (`shellcheck`, `hadolint`, `actionlint`) must be installed separately (`brew install shellcheck hadolint actionlint`).

## Architecture

All CLI logic lives in `src/harness.ts` (compiles to `bin/harness.js`). It:

1. Parses CLI args via `minimist`
2. Selects an adapter (`PiAdapter`, `OpenCodeAdapter`, or `HermesAdapter`) based on `--agent` flag
3. Constructs and spawns a `<runtime> run` command (`docker` by default, or Apple's `container` when `HARNESS_CONTAINER_RUNTIME=apple`) that mounts `$PWD` and passes the prompt via stdin or `-e`

**Adapter pattern:** Each adapter implements how to invoke the agent binary inside the container (command, flags, env vars). Adding a new agent means adding a new adapter class and registering it in the `ADAPTERS` map.

### Image structure

The project uses a **multi-image architecture** with a shared base and agent-specific variants:

| Image | Dockerfile | Tag pattern | Contents |
|-------|-----------|-------------|----------|
| Base (pi) | `Dockerfile` | `<version>` | Debian stable-slim, Node.js v24, pnpm, `git`, `pi-coding-agent`, `gh`, `mise`, `tini`, `fd`, `ripgrep`, `jq` |
| OpenCode | `Dockerfile.opencode` | `opencode-<version>` | Base + `opencode-ai` |
| Hermes | `Dockerfile.hermes` | `hermes-<version>` | Base + `uv`, `cosign`, `tirith`, Python venv with `hermes-agent` (incl. MCP SDK), `python-telegram-bot`, `croniter`, `faster-whisper` |

The image tag is selected at runtime based on `--agent`: pi uses `<version>`, others use `<agent>-<version>`.

### Key subsystems

**Cosign image verification (`verifyImage`):** On every run (unless `--no-verify` or `HARNESS_IMAGE_TAG` is set), harness verifies the container image was signed by the official CI workflow and carries a valid SLSA provenance attestation. Verified digests are cached at `~/.cache/harness/cosign-verified.json`. Requires `cosign` installed on the host.

**Container runtime selection (`HARNESS_CONTAINER_RUNTIME`):** The host container runtime is abstracted behind a `ContainerRuntime` interface in `src/harness.ts` with two implementations: `DockerRuntime` (default, reproduces the original argv byte-for-byte) and `AppleContainerRuntime` (Apple's native `container` CLI for macOS 26 / Apple Silicon). Selection is case-insensitive over named values — `docker` (default/unset) or `apple`; any other value is a hard error. The runtime owns the binary name, the pull subcommand (`docker pull` vs `container image pull`), local digest lookup (`docker image inspect --format` Go-template vs `container image inspect` JSON → `data[0].configuration.descriptor.digest`, rebuilt into `repo@sha256:<digest>`), and the final `run` argv. The apple path emits `-i`/`-t` separately (no clustered `-it`), space-separated capability flags (`--cap-drop ALL` not `--cap-drop=ALL`), and **omits** `--security-opt` entirely — `apple/container` has no such option, and its microVM isolation (per-workload guest kernel under Apple's Virtualization framework) subsumes the host-kernel role of the `block-af-alg.json` seccomp profile; `--cap-drop=ALL --cap-add=NET_RAW` stays (capabilities are supported). A `container --version` prerequisite probe runs before any spawn and prints an install hint if the binary is missing. Everything else (adapters, `persistMounts`, skills/context-file mounts, ephemeral logic, cloud-mode env, image-tag selection, entrypoints, Dockerfiles, CI) is runtime-agnostic and unchanged. The cosign verified-digest cache is keyed by digest, not runtime, so a digest verified under one runtime is a cache hit under the other.

**Persistence:** Interactive runs (no `-p`, no piped stdin, no `--ephemeral`) store persistence data at `$XDG_DATA_HOME/harness/<normalized-cwd>/<agent>/` (defaults to `~/.local/share/harness/`). The `<normalized-cwd>` is computed by `normalizeCwd()`: strips `os.homedir()` prefix, replaces `/` with `_`, uses `_home` if empty. Each adapter declares its own mount points via `persistMounts()`. The container's `~/.config` is persisted at the project (cwd) level — `<persist-root>/../xdg_config` → `/home/harness/.config` (one level above the per-agent root, shared across all agents working in the same project; for opencode the per-agent `.config/opencode` mount nests inside it). Per-agent persistence includes: `<persist-root>/mise/` → `/home/harness/.local/share/mise` (tools/plugins, `MISE_DATA_DIR`), `<persist-root>/mise-state/` → `/home/harness/.local/state/mise` (trust settings, `MISE_STATE_DIR`), and `<persist-root>/npm/` → `/home/harness/.local/share/npm` (pi adapter only: extensions/skills installed via `npm install -g`, `NPM_CONFIG_PREFIX`). One-shot runs are implicitly ephemeral. A deprecation warning is emitted if an old `.harness/` directory exists in the CWD.

**User skills:** By default, harness bind-mounts the host user's skills directories into the container so agents can discover and use custom skills. Two source directories are checked (only if they exist on the host):

- `~/.agents/skills` → `/home/harness/.agents/skills`
- `~/.claude/skills` → `/home/harness/.claude/skills`

Skills mounting applies to all run modes (interactive, one-shot, `--file`). Non-existent directories are silently skipped. Disable with `--no-skills`.

**Entrypoints:** Each variant has its own entrypoint that seeds default configs into the agent's home directory and selects local vs cloud mode based on the `HARNESS_CLOUD_MODE` env var. In-container self-update notifications are disabled per agent (#100): pi sets `PI_SKIP_VERSION_CHECK` in `entrypoint.sh`, opencode sets `OPENCODE_DISABLE_AUTOUPDATE` in `entrypoint-opencode.sh`, and hermes stamps `~/.hermes/.install_method` as `docker` in `entrypoint-hermes.sh`. All three entrypoints source `/etc/harness/setup-env.sh` (`setup-env.sh` in the repo, baked into the base image) for shared environment setup — it sets `GIT_CONFIG_GLOBAL=/home/harness/.config/gitconfig` (after `mkdir -p ~/.config`): git's default `~/.gitconfig` is NOT persisted by harness, but `~/.config` is (project-level), so this routes an identity set via `git config --global` into a file that survives across runs. On first run it also seeds that gitconfig with the `gh` credential helper for `github.com` / `gist.github.com`, so HTTPS git operations authenticate via the token `gh` stores after `gh auth login`; the seed is skipped once the file exists so later manual edits are preserved.

- `entrypoint.sh` (pi) — seeds pi defaults from `/etc/harness/pi-defaults`; disables pi self-update checks
- `entrypoint-opencode.sh` — without `HARNESS_CLOUD_MODE`, sets LM Studio config and default model; with `HARNESS_CLOUD_MODE`, does nothing (agent auto-detects from env vars)
- `entrypoint-hermes.sh` — minimal entrypoint (hermes self-seeds on first run)

**Cloud/local mode:** When `-e` is passed without `--local`, harness injects `HARNESS_CLOUD_MODE=1` into the container, signaling entrypoints to skip local defaults and let agents auto-detect providers from whatever API keys are in the env file. Without `-e` (or with `-e --local`), entrypoints use local mode (LM Studio, local configs). This is agent-agnostic — any provider key in the env file works without hardcoding specific variable names.

**Dependency cooldown:** All dependencies must be at least 7 days old before upgrading. pnpm enforces this at build time via `PNPM_MINIMUM_RELEASE_AGE=10080`. uv enforces the same cooldown via `--exclude-newer=$(date -u -d '7 days ago' '+%Y-%m-%dT%H:%M:%SZ')` passed directly to `uv pip install` in `Dockerfile.hermes`. hermes-agent is installed via `git clone` and therefore bypasses uv's cooldown; the `check-deps` skill enforces the 7-day window manually by parsing the release date from the `vYYYY.M.DD` tag format. For other deps (gh, cosign, etc.), the `check-deps` skill checks the GitHub release publish date against the 7-day window.

**Agent configs:** `pi/models.json`, `opencode/lmstudio.json`, `opencode/openrouter.json`, `opencode/anthropic.json`, `opencode/openai.json`, `opencode/google.json`, `opencode/zai.json` define provider/model settings copied into the container.

## CI/CD

The GitHub Actions workflows (`.github/workflows/`):

- **`docker.yml`** — Builds and pushes multi-arch (amd64 + arm64) images to `ghcr.io/boldblackai/harness` on push to `main` and on release tags. Signs images with cosign and attests SLSA provenance. Builds base first, then opencode and hermes variants in parallel using the base image digest.
- **`lint.yml`** — Runs `pnpm lint` on push to `main` and on PRs.
- **`e2e.yml`** — Runs `pnpm test:e2e` on all branches and PRs. Tests against Node 22 and 24.
- **`pr-build.yml`** — Builds all three Docker images (base + variants) on PRs using a local registry to catch build failures before merge.
- **`docs.yml`** — Builds the Zensical docs site. On push to `main` (and `workflow_dispatch`) it deploys to GitHub Pages; on PRs that touch `docs/`, `zensical.toml`, or the workflow it runs a build-only check (the `build` job) without deploying. The `deploy` job is gated with `if: github.event_name != 'pull_request'` and the Pages artifact upload is skipped on PRs.

Custom composite action: `.github/actions/attest-provenance` for SLSA provenance attestation.

## Tests

E2E tests in `tests/e2e/*.test.mjs` (with shared helpers in `helpers.mjs`) use a docker shim (a fake `docker` binary that prints `DOCKER_INVOKED <args>`) to exercise the full CLI without requiring Docker. Files run in lexicographic order: `adapters → mounts → parsing → persistence → runtime`. Tests cover:

- Argument parsing and validation (`--help`, unknown agent, missing files)
- Adapter behavior (pi, opencode, hermes command construction)
- Image tag selection per agent
- Security flags (`--cap-drop=ALL`, `--security-opt`, etc.)
- Persistence vs ephemeral behavior (TTY detection, `--ephemeral`, `-p`)
- Volume mount construction (file vs directory, adapter-specific mount points, npm persistence)
- `--env-file` forwarding across all adapters
- `--model` handling (local vs env-file mode, `--provider ollama` injection)
- Cloud/local mode (`HARNESS_CLOUD_MODE`, `--local` flag)
- User skills mounting (`~/.agents/skills`, `~/.claude/skills`, `--no-skills` flag)

Run with: `pnpm test:e2e` (requires `pnpm build` first).

### Coverage

The e2e workflow enforces 80% line/branch/function coverage thresholds via Node.js built-in `--experimental-test-coverage`. Locally, run: `pnpm test:coverage` (requires `pnpm build` first).

## RFCs

Significant changes, architectural decisions, and new features should be proposed as RFCs in the `rfcs/` directory. RFCs use the format `rfcs/YYYY-MM-DD_short_title.md` with the following structure:

- `# Title` — short descriptive title
- `**Date:**` — proposal date (ISO format)
- `**Status:**` — `Proposed`, `Accepted`, `Implemented`, or `Rejected`
- `## Goal` — what the RFC aims to accomplish
- Remaining sections are free-form but typically include motivation, technical details, migration notes, and an implementation checklist

See `rfcs/2025-05-23_agent_persistence.md` for a complete example.

## Rules

- Keep `README.md` and `AGENTS.md` updated when changing CLI flags, options, architecture, Dockerfiles, CI workflows, or any behavior. If you change how something works, update both files to reflect it.
- All fenced code blocks in markdown files MUST specify a language (e.g. `bash`, `typescript`, `text`). This is enforced by markdownlint rule MD040.
- All dependencies in Dockerfiles MUST be pinned: base images by digest, multi-stage source images by version tag, npm/pnpm packages by exact version, git-cloned agents by tag or commit SHA.
- All downloaded binaries in Dockerfiles MUST include checksum verification (sha256sum).
- When adding a new agent adapter: add the class, register it in `ADAPTERS`, create a `Dockerfile.<name>`, `entrypoint-<name>.sh`, and update `Makefile` with `image-<name>` target.
- E2E tests must remain runnable without Docker (shim-based).
- GitHub Actions in `.github/workflows/` MUST pin third-party actions by full commit SHA (e.g. `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd`), not by tag (e.g. `actions/checkout@v5`). Include the version tag as a comment for readability. Local actions (`uses: ./.github/actions/...`) are exempt.
