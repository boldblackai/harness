<p align="center" style="margin-bottom: 0">
  <img alt="harness" src="logo-light.png#gh-light-mode-only" width="250">
  <img alt="harness" src="logo-dark.png#gh-dark-mode-only" width="250">
</p>

<p align="center">
  <strong>Run agents in a sandboxed container — ready to drop into any project.</strong>
</p>

Harness conveniently wraps Docker around three open-source coding agents — [`pi`](https://pi.dev/), [`opencode`](https://opencode.ai),
and [`hermes`](https://github.com/NousResearch/hermes-agent) — so you can point one at a directory (or file) without giving it access to your entire machine.

> **Documentation:** [boldblackai.github.io/harness](https://boldblackai.github.io/harness/)

## Features

- **Sandboxed by default** — capability-dropped container with `no-new-privileges`; the agent only sees the directory (or file) you mount.
- **Three agents, one CLI** — switch between `pi`, `opencode`, and `hermes` with `-a`. Same flags, same flow.
- **Supply-chain hardened** — the image is signed and verified with cosign and SLSA provenance on every run; dependencies installed inside the container are always pinned and verified where possible and a 7-day "cooldown" is used to mitigate supply-chain attacks.
- **Local-first** — defaults to LM Studio with `gemma-4-e4b`. Drop in an `--env-file` to use Anthropic, OpenRouter, OpenAI, Gemini, and others.
- **Stateful or one-shot** — interactive runs persist agent state under `$XDG_DATA_HOME/harness/<project>/<agent>/` (defaults to `~/.local/share/harness/`); one-shot prompts (`-p` or piped stdin) stay ephemeral.
- **User skills** — automatically mounts `~/.agents/skills` and `~/.claude/skills` into the container so agents can discover and use custom skills. Disable with `--no-skills`.
- **Context files** — automatically mounts `~/.agents/AGENTS.md` and `~/.claude/CLAUDE.md` into the agent's context directory so cross-agent rules apply inside the container. Disable with `--no-context-files` (`-nc`).
- **Zero install** — `npx @boldblackai/harness` just works.

## Quickstart

A container runtime is required. By default harness uses [Docker](https://www.docker.com); on macOS 26 / Apple Silicon you can also use Apple's native [`container`](https://github.com/apple/container) CLI — see [Container runtime](#container-runtime). With the default runtime and LM Studio locally:

```bash
lms daemon up
lms get google/gemma-4-e4b
```

The container is preconfigured to use `gemma-4-e4b` via LM Studio's local API.

You can also specify a different local model with `-m`. HuggingFace-style names with slashes (e.g. `qwen/qwen3.5-9b`) work correctly in local mode:

```bash
npx @boldblackai/harness -m "qwen/qwen3.5-9b" -p "write a fizzbuzz in Go"
```

### Using a cloud provider instead

#### pi (default agent)

If you pass an API key for a supported provider via `--env-file`, [`pi`](https://pi.dev/) will use that provider instead of the local LM Studio setup. Supported keys:

| Provider | Environment Variable |
|----------|----------------------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| Hugging Face | `HF_TOKEN` |

See the [full list of supported providers](https://github.com/badlogic/pi-mono/blob/c779c14e91bc2ea65143e59b0dc1baf3646ba8c9/packages/coding-agent/docs/providers.md#api-keys) for more options. When using LM Studio locally, 16k context is sufficient.

#### opencode agent

[`opencode`](https://opencode.ai) uses LM Studio by default. Pass `--env-file` to switch to cloud mode — the agent auto-detects the provider from whichever API key is in the file:

```bash
echo 'OPENROUTER_API_KEY=sk-...' > .env
npx @boldblackai/harness -e .env -p "write me a fizzbuzz in Go"
```

That's it. Your current directory is mounted at `/workspace` inside the container and the agent works against it.

## Contents

- [Examples](#examples)
- [Agents](#agents)
  - [pi (default)](#pi-default)
  - [opencode](#opencode)
  - [hermes](#hermes)
- [Security model](#security-model)
  - [Sandbox](#sandbox)
  - [Image verification](#image-verification)
  - [Dependency cooldown](#dependency-cooldown)
- [Persistence](#persistence)
- [Reference](#reference)
  - [CLI flags](#cli-flags)
  - [Environment variables](#environment-variables)
  - [Agent-specific behavior](#agent-specific-behavior)
- [Deploying hermes as a claw](#deploying-hermes-as-a-claw)
- [Developing](#developing)

## Examples

```bash
# One-shot prompt
npx @boldblackai/harness -p "write me a fizzbuzz in Go"

# Pipe via stdin
echo "write me a fizzbuzz in Go" | npx @boldblackai/harness

# Interactive session (no -p, no piped stdin) — state persists under XDG data dir
npx @boldblackai/harness

# Use a cloud provider via env file
npx @boldblackai/harness -e .env -p "add a login endpoint"

# Override the model
npx @boldblackai/harness -m anthropic/claude-sonnet-4-5 -p "refactor the auth module"

# Mount a single file instead of the whole directory
npx @boldblackai/harness -f ./script.py -p "add type hints"

# Switch agents
npx @boldblackai/harness -a opencode -p "write me a fizzbuzz in Go"
npx @boldblackai/harness -a hermes -e .env -p "add tests"
```

`npx`, `bunx`, and `pnpm dlx` are interchangeable. Or install globally:

```bash
npm install -g @boldblackai/harness
# or
pnpm add -g @boldblackai/harness
# or
bun add -g @boldblackai/harness
```

## Agents

Pick an agent with `-a`. Default is `pi`.

### pi (default)

[`pi`](https://pi.dev/) defaults to LM Studio with `google/gemma-4-e4b` (16k context is enough). Pass an `--env-file` containing any of the keys below and `pi` switches to that provider:

| Provider      | Environment Variable |
|---------------|----------------------|
| Anthropic     | `ANTHROPIC_API_KEY`  |
| OpenRouter    | `OPENROUTER_API_KEY` |
| OpenAI        | `OPENAI_API_KEY`     |
| Google Gemini | `GEMINI_API_KEY`     |
| Mistral       | `MISTRAL_API_KEY`    |
| Groq          | `GROQ_API_KEY`       |
| Cerebras      | `CEREBRAS_API_KEY`   |
| xAI           | `XAI_API_KEY`        |
| Hugging Face  | `HF_TOKEN`           |

See the [full provider list](https://github.com/badlogic/pi-mono/blob/c779c14e91bc2ea65143e59b0dc1baf3646ba8c9/packages/coding-agent/docs/providers.md#api-keys). The `-m` flag is forwarded directly.

### opencode

[`opencode`](https://opencode.ai) defaults to LM Studio in local mode. Pass `--env-file` to enter cloud mode — the agent auto-detects the provider from whichever API key is in the file (`ZAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, etc.). The `-m` flag takes a bare model name; the provider prefix is added for you.

```bash
npx @boldblackai/harness -a opencode -e .env -p "refactor the auth module"
npx @boldblackai/harness -a opencode -e .env -m anthropic/claude-sonnet-4-5 -p "add tests"
```

To pass env vars but stay in local mode, use `--local`:

```bash
npx @boldblackai/harness -a opencode -e .env --local -p "refactor the auth module"
```

When using LM Studio locally, set the model's context length to at least 32k tokens.

### hermes

[`hermes`](https://github.com/NousResearch/hermes-agent) by NousResearch supports many providers. Pass `--env-file` to enter cloud mode — the agent auto-detects the provider from whichever API key is in the file. Use a `provider/model` for `-m`:

```bash
npx @boldblackai/harness -a hermes -e .env -m anthropic/claude-sonnet-4-5 -p "add tests"
npx @boldblackai/harness -a hermes -e .env -m openrouter/auto -p "add tests"
```

Common keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GLM_API_KEY` (Z.AI), [and others](https://github.com/NousResearch/hermes-agent/blob/main/.env.example). LM Studio context length should be at least 64k tokens.

**Multiple API keys in one env file.** With `--env-file`, each agent auto-detects a provider from the keys present. If the file contains keys for more than one provider (e.g. `OPENROUTER_API_KEY` and `GLM_API_KEY`), the agent may not pick the one you expect — `pi` and `opencode` follow their own detection order. For one-shot runs, use a single-provider env file, or select the agent and model explicitly (e.g. `harness -a hermes -e .env -m zai/glm-4.7 -p "..."`).

## Security model

Harness layers protections at runtime, image, and dependency level.

### Sandbox

Each run starts the container with:

- `--cap-drop=ALL --cap-add=NET_RAW` — minimal capability set
- `--security-opt no-new-privileges:true` — block privilege escalation
- `--security-opt seccomp=...` — inline seccomp profile blocks `socket(AF_ALG)` to prevent kernel crypto API access (a known container escape vector)
- Only your mounted directory (or single file with `-f`) is visible to the agent

These hardening flags are docker-specific. Under `HARNESS_CONTAINER_RUNTIME=apple`, `--security-opt` is not applied (apple/container workloads are microVMs with their own guest kernel, so the seccomp profile's host-kernel role is subsumed by the VM boundary); capability restrictions remain. See [Container runtime](#container-runtime).

### Image verification

By default, harness verifies that the container image was signed by the official CI workflow and carries a valid SLSA provenance attestation. This requires [cosign](https://github.com/sigstore/cosign):

```bash
brew install cosign
```

Verified digests are cached at `~/.cache/harness/cosign-verified.json` so verification only runs once per image. Skip with `--no-verify` (or by setting `HARNESS_IMAGE_TAG`, which implies skip):

```bash
npx @boldblackai/harness --no-verify -p "write me a fizzbuzz in Go"
```

### Dependency cooldown

The image build enforces a 7-day cooldown on dependency resolution — a guard against supply-chain compromises that are typically discovered and yanked within hours.

- **pnpm**: `PNPM_MINIMUM_RELEASE_AGE=10080` (minutes) via environment variable
- **uv**: `--exclude-newer` set to 7 days ago at image build time

The cooldown applies to transitive dependencies too. Older packages install normally.

## Persistence

Interactive runs (no `-p` and no piped stdin) store persistence data at `$XDG_DATA_HOME/harness/<project>/<agent>/` (defaults to `~/.local/share/harness/`). The `<project>` segment is the working directory path with `/` replaced by `_` and the home prefix stripped. This lets agents resume sessions, skip database migrations on repeat runs, and retain memories across invocations. The container's `~/.config` is persisted at `<persist-root>/../xdg_config` (one level above the per-agent root, i.e. `$XDG_DATA_HOME/harness/<project>/xdg_config`), so tool configs (e.g. jj) survive across runs and are shared by every agent working in the same project. For the opencode adapter the existing per-agent `.config/opencode` mount nests inside this project-level one. Per-agent `mise` tool data and trust settings are persisted at `<persist-root>/mise/` and `<persist-root>/mise-state/` respectively. For the pi adapter, extensions/skills installed via `npm install -g` are persisted at `<persist-root>/npm/`, avoiding re-downloads on every boot.

One-shot runs (`-p` or piped stdin) are implicitly ephemeral — no persistence data is created. Use `--ephemeral` to force-disable persistence on interactive runs.

If an old `.harness/` directory exists in your working directory, harness will emit a deprecation warning with migration instructions.

## Reference

### CLI flags

| Flag          | Alias | Description |
|---------------|-------|-------------|
| `--prompt`    | `-p`  | Pass a prompt directly to the agent |
| `--env-file`  | `-e`  | Load environment variables into the container |
| `--file`      | `-f`  | Mount a single file instead of the current directory |
| `--model`     | `-m`  | Override the model used by the agent |
| `--agent`     | `-a`  | Select agent: `pi`, `opencode`, `hermes` (default: `pi`) |
| `--volumes`   | `-v`  | Additional volume mount (`host:container[:opts]`); may be repeated |
| `--no-verify` |       | Skip cosign signature and provenance verification |
| `--no-skills` |       | Disable mounting user skills directories (`~/.agents/skills`, `~/.claude/skills`) |
| `--no-context-files` | `-nc` | Disable mounting global context files (`~/.agents/AGENTS.md`, `~/.claude/CLAUDE.md`) |
| `--ephemeral` |       | Disable session persistence (implied by `-p` and piped stdin) |
| `--local`     |       | Force local mode even with `-e` (use LM Studio / local defaults) |
| `--help`      | `-h`  | Show help |

### Environment variables

| Variable                    | Description |
|-----------------------------|-------------|
| `HARNESS_IMAGE_TAG`         | Override the Docker image tag (defaults to the package version). Setting this implies `--no-verify`. |
| `HARNESS_CONTAINER_RUNTIME` | Container runtime to use: `docker` (default) or `apple` (Apple's [`container`](https://github.com/apple/container) CLI). |
| `XDG_DATA_HOME`             | Override the base directory for persistence data (defaults to `~/.local/share`). |
| `XDG_CACHE_HOME`            | Override the base directory for the cosign cache (defaults to `~/.cache`). |

#### Container runtime

By default harness runs images with `docker`. On macOS 26 / Apple Silicon you can opt into Apple's native [`container`](https://github.com/apple/container) CLI (v1.0.0+) instead, which runs OCI images as lightweight Linux microVMs:

```bash
brew install container     # install Apple's container CLI (v1.0.0+)
container system start     # one-time: start the container system service
container system kernel set --recommended --arch arm64   # one-time on Apple Silicon (required before first run)
export HARNESS_CONTAINER_RUNTIME=apple
harness -p "write me a fizzbuzz in Go"
```

On arm64 Macs, `container system kernel set --recommended` is required — without it the first `harness` run fails with `default kernel not configured for architecture arm64`. See [apple/container](https://github.com/apple/container) for details.

The value is **named, not boolean** (`apple` or `docker`, case-insensitive); any other value is a hard error. harness never auto-detects the runtime — you must opt in. Image verification (cosign + SLSA provenance) works identically under both runtimes; the verified-digest cache is keyed by digest, so a digest verified under one runtime is a cache hit under the other.

**Security note.** Under `=apple`, harness does not apply the `--security-opt no-new-privileges` and `--security-opt seccomp=...` flags it uses under docker, because `apple/container` has no `--security-opt` option. This is not a security regression: each apple/container workload is a microVM with its own ephemeral guest kernel (Apple Virtualization framework), so the `block-af-alg.json` profile's host-kernel role — blocking `socket(AF_ALG)` — is subsumed by the VM boundary itself (hardware-assisted isolation, strictly stronger than a syscall filter). Capability restrictions (`--cap-drop=ALL --cap-add=NET_RAW`) **are** supported and stay on. Only `ro`/`readonly` is honored for volume options under the apple path (SELinux relabel flags like `:Z` are meaningless under macOS virtiofs).

### Agent-specific behavior

- **pi** — `-m` is passed straight to the binary as `--model`.
- **opencode** — `-m` is passed via the `OPENCODE_MODEL` env var. Without `-e`, uses LM Studio locally. With `-e`, enters cloud mode and auto-detects the provider from whichever API key is in the env file. Use `--local` to force local mode even with `-e`.
- **hermes** — `-m` is passed as `--model` in `provider/model` form. Without `-e`, uses local config. With `-e`, enters cloud mode and auto-detects from env vars. Use `--local` to force local mode even with `-e`.

## Deploying hermes as a claw

You can run `hermes` as a long-running "claw" — a persistent agent process reachable over a messaging gateway (e.g. Telegram). Three deployment targets are documented:

- [fly.io](docs/deploying-to-fly.md)
- [Kubernetes](docs/deploying-to-k8s.md)
- [AWS (ECS Fargate or EC2 + SSM)](docs/deploying-to-aws.md)

## Developing

Link your local checkout globally:

```bash
pnpm link --global
# unlink with:
pnpm unlink --global @boldblackai/harness
```

### Building the image

```bash
make image
```

Builds `ghcr.io/boldblackai/harness` with Debian stable-slim, Node.js v24, `git`, [`@earendil-works/pi-coding-agent`](https://pi.dev/), [`opencode-ai`](https://opencode.ai), [`hermes-agent`](https://github.com/NousResearch/hermes-agent), `fd`, `ripgrep`, `jq`, and `curl`. The hermes variant also includes the [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) for connecting to MCP servers, and [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) for local speech-to-text.

The base image is pinned by manifest-list digest (the OCI image index, not a per-platform manifest) for reproducible multi-arch builds. To bump it:

```bash
docker buildx imagetools inspect debian:stable-slim --format '{{.Manifest.Digest}}'
```

### Linting

```bash
pnpm lint           # all
pnpm lint:ts        # Biome
pnpm lint:md        # markdownlint
pnpm lint:sh        # shellcheck
pnpm lint:docker    # hadolint
pnpm lint:actions   # actionlint
pnpm format         # auto-format with Biome
```

`shellcheck`, `hadolint`, and `actionlint` are system binaries. Install with [mise](https://mise.jdx.dev/) (recommended):

```bash
mise install
```

Or install manually:

```bash
brew install shellcheck hadolint actionlint
```
