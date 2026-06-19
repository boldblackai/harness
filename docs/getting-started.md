---
icon: lucide/rocket
---

# Getting Started

## Prerequisites

- [Docker](https://www.docker.com/) installed and running
- For local mode: [LM Studio](https://lmstudio.ai/) with a model loaded

## Installation

No installation required. Run directly with `npx`:

```bash
npx @boldblackai/harness
```

Or install globally:

```bash
npm install -g @boldblackai/harness
# or
pnpm add -g @boldblackai/harness
# or
bun add -g @boldblackai/harness
```

## Local mode (LM Studio)

Start LM Studio and load a model:

```bash
lms daemon up
lms get google/gemma-4-e4b
```

Run harness:

```bash
npx @boldblackai/harness -p "write a fizzbuzz in Go"
```

### Interactive sessions

Run without `-p` for an interactive session — agent state persists across runs:

```bash
npx @boldblackai/harness
```

### Pipe input

```bash
echo "write me a fizzbuzz in Go" | npx @boldblackai/harness
```

## Cloud mode

Pass an `--env-file` containing your API key to use a cloud provider:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-***" > .env
npx @boldblackai/harness -e .env -p "add a login endpoint"
```

To pass env vars but stay in local mode, use `--local`:

```bash
npx @boldblackai/harness -e .env --local -p "refactor the auth module"
```

## Common flags

```bash
# Choose an agent
npx @boldblackai/harness -a opencode -p "write tests"

# Override the model
npx @boldblackai/harness -m anthropic/claude-sonnet-4-5 -p "refactor auth"

# Mount a single file instead of the directory
npx @boldblackai/harness -f ./script.py -p "add type hints"

# Skip image verification
npx @boldblackai/harness --no-verify -p "quick task"
```

See the full reference at [Configuration](configuration.md).
