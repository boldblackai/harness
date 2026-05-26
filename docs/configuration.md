---
icon: lucide/settings
---

# Configuration

## CLI flags

| Flag          | Alias | Description |
|---------------|-------|-------------|
| `--prompt`    | `-p`  | Pass a prompt directly to the agent |
| `--env-file`  | `-e`  | Load environment variables into the container |
| `--file`      | `-f`  | Mount a single file instead of the current directory |
| `--model`     | `-m`  | Override the model used by the agent |
| `--agent`     | `-a`  | Select agent: `pi`, `opencode`, `hermes` (default: `pi`) |
| `--volumes`   | `-v`  | Additional volume mount (`host:container[:opts]`); may be repeated |
| `--no-verify` |       | Skip cosign signature and provenance verification |
| `--no-skills` |       | Disable mounting user skills directories |
| `--ephemeral` |       | Disable session persistence (implied by `-p` and piped stdin) |
| `--local`     |       | Force local mode even with `-e` (use LM Studio / local defaults) |
| `--help`      | `-h`  | Show help |

## Environment variables

| Variable             | Description |
|----------------------|-------------|
| `HARNESS_IMAGE_TAG`  | Override the Docker image tag (defaults to the package version). Setting this implies `--no-verify`. |
| `XDG_DATA_HOME`      | Override the base directory for persistence data (defaults to `~/.local/share`). |
| `XDG_CACHE_HOME`     | Override the base directory for cosign cache (defaults to `~/.cache`). |

## Agent-specific behavior

### pi

- `-m` is passed straight to the binary as `--model`
- Without `-e`, passes `--provider ollama` so pi routes to LM Studio

### opencode

- `-m` is passed via the `OPENCODE_MODEL` env var
- Without `-e`, uses LM Studio locally
- With `-e`, enters cloud mode and auto-detects the provider from env vars
- Use `--local` to force local mode even with `-e`

### hermes

- `-m` is passed as `--model` in `provider/model` form
- Without `-e`, uses local config
- With `-e`, enters cloud mode and auto-detects from env vars
- Use `--local` to force local mode even with `-e`
