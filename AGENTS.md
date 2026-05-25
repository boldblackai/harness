# harness

## Project Overview

**Harness** is a portable containerized environment for running coding agents. See README.md for more project details.

**Documentation website:** Built with [Zensical](https://zensical.org) from `docs/`. Config in `zensical.toml`. Deploys to GitHub Pages via `.github/workflows/docs.yml`. Build locally with `pip install zensical && zensical build --clean`.

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
3. Constructs and spawns a `docker run` command that mounts `$PWD` and passes the prompt via stdin or `-e`

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

**Persistence:** Interactive runs (no `-p`, no piped stdin, no `--ephemeral`) store persistence data at `$XDG_DATA_HOME/harness/<normalized-cwd>/<agent>/` (defaults to `~/.local/share/harness/`). The `<normalized-cwd>` is computed by `normalizeCwd()`: strips `os.homedir()` prefix, replaces `/` with `_`, uses `_home` if empty. Each adapter declares its own mount points via `persistMounts()`. Per-agent `mise` data is persisted via two volume mounts: `<persist-root>/mise/` → `/home/harness/.local/share/mise` (tools/plugins, `MISE_DATA_DIR`) and `<persist-root>/mise-state/` → `/home/harness/.local/state/mise` (trust settings, `MISE_STATE_DIR`). One-shot runs are implicitly ephemeral. A deprecation warning is emitted if an old `.harness/` directory exists in the CWD.

**User skills:** By default, harness bind-mounts the host user's skills directories into the container so agents can discover and use custom skills. Two source directories are checked (only if they exist on the host):

- `~/.agents/skills` → `/home/harness/.agents/skills`
- `~/.claude/skills` → `/home/harness/.claude/skills`

Skills mounting applies to all run modes (interactive, one-shot, `--file`). Non-existent directories are silently skipped. Disable with `--no-skills`.

**Entrypoints:** Each variant has its own entrypoint that seeds default configs into the agent's home directory and detects the provider from env vars:

- `entrypoint.sh` (pi) — seeds pi defaults from `/etc/harness/pi-defaults`
- `entrypoint-opencode.sh` — detects `OPENROUTER_API_KEY` to switch between LM Studio and OpenRouter configs; sets `OPENCODE_MODEL` env var
- `entrypoint-hermes.sh` — seeds hermes defaults from `/etc/harness/hermes-defaults/{local,openrouter}`; sets `HERMES_HOME` based on provider

**Dependency cooldown:** All dependencies must be at least 7 days old before upgrading. pnpm enforces this at build time via `PNPM_MINIMUM_RELEASE_AGE=10080`. uv enforces the same cooldown via `--exclude-newer=$(date -u -d '7 days ago' '+%Y-%m-%dT%H:%M:%SZ')` passed directly to `uv pip install` in `Dockerfile.hermes`. hermes-agent is installed via `git clone` and therefore bypasses uv's cooldown; the `check-deps` skill enforces the 7-day window manually by parsing the release date from the `vYYYY.M.DD` tag format. For other deps (gh, cosign, etc.), the `check-deps` skill checks the GitHub release publish date against the 7-day window.

**Agent configs:** `pi/models.json`, `opencode/lmstudio.json`, `opencode/openrouter.json`, `hermes/local.yaml`, `hermes/openrouter.yaml` define provider/model settings copied into the container.

## CI/CD

Four GitHub Actions workflows (`.github/workflows/`):

- **`docker.yml`** — Builds and pushes multi-arch (amd64 + arm64) images to `ghcr.io/capotej/harness` on push to `main` and on release tags. Signs images with cosign and attests SLSA provenance. Builds base first, then opencode and hermes variants in parallel using the base image digest.
- **`lint.yml`** — Runs `pnpm lint` on push to `main` and on PRs.
- **`e2e.yml`** — Runs `pnpm test:e2e` on all branches and PRs. Tests against Node 22 and 24.
- **`pr-build.yml`** — Builds all three Docker images (base + variants) on PRs using a local registry to catch build failures before merge.

Custom composite action: `.github/actions/attest-provenance` for SLSA provenance attestation.

## Tests

E2E tests in `tests/e2e/cli.test.mjs` use a docker shim (a fake `docker` binary that prints `DOCKER_INVOKED <args>`) to exercise the full CLI without requiring Docker. Tests cover:

- Argument parsing and validation (`--help`, unknown agent, missing files)
- Adapter behavior (pi, opencode, hermes command construction)
- Image tag selection per agent
- Security flags (`--cap-drop=ALL`, `--security-opt`, etc.)
- Persistence vs ephemeral behavior (TTY detection, `--ephemeral`, `-p`)
- Volume mount construction (file vs directory, adapter-specific mount points)
- `--env-file` forwarding across all adapters
- `--model` handling (local vs env-file mode, `--provider ollama` injection)
- User skills mounting (`~/.agents/skills`, `~/.claude/skills`, `--no-skills` flag)

Run with: `pnpm test:e2e` (requires `pnpm build` first).

### Coverage

The e2e workflow enforces 80% line/branch/function coverage thresholds via Node.js built-in `--experimental-test-coverage`. Locally, run: `pnpm test:coverage` (requires `pnpm build` first).

## Rules

- Keep `README.md` and `AGENTS.md` updated when changing CLI flags, options, architecture, Dockerfiles, CI workflows, or any behavior. If you change how something works, update both files to reflect it.
- All fenced code blocks in markdown files MUST specify a language (e.g. `bash`, `typescript`, `text`). This is enforced by markdownlint rule MD040.
- All dependencies in Dockerfiles MUST be pinned: base images by digest, multi-stage source images by version tag, npm/pnpm packages by exact version, git-cloned agents by tag or commit SHA.
- All downloaded binaries in Dockerfiles MUST include checksum verification (sha256sum).
- When adding a new agent adapter: add the class, register it in `ADAPTERS`, create a `Dockerfile.<name>`, `entrypoint-<name>.sh`, and update `Makefile` with `image-<name>` target.
- E2E tests must remain runnable without Docker (shim-based).
