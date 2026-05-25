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
npx @capotej/harness
```

Or install globally:

```bash
npm install -g @capotej/harness
# or
pnpm add -g @capotej/harness
# or
bun add -g @capotej/harness
```

## Local mode (LM Studio)

Start LM Studio and load a model:

```bash
lms daemon up
lms get google/gemma-4-e4b
```

Run harness:

```bash
npx @capotej/harness -p "write a fizzbuzz in Go"
```

### Interactive sessions

Run without `-p` for an interactive session — agent state persists across runs:

```bash
npx @capotej/harness
```

### Pipe input

```bash
echo "write me a fizzbuzz in Go" | npx @capotej/harness
```

## Cloud mode

Pass an `--env-file` containing your API key to use a cloud provider:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-***" > .env
npx @capotej/harness -e .env -p "add a login endpoint"
```

To pass env vars but stay in local mode, use `--local`:

```bash
npx @capotej/harness -e .env --local -p "refactor the auth module"
```

## Common flags

```bash
# Choose an agent
npx @capotej/harness -a opencode -p "write tests"

# Override the model
npx @capotej/harness -m anthropic/claude-sonnet-4-5 -p "refactor auth"

# Mount a single file instead of the directory
npx @capotej/harness -f ./script.py -p "add type hints"

# Skip image verification
npx @capotej/harness --no-verify -p "quick task"
```

See the full reference at [Configuration](configuration.md).
