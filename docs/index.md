---
icon: lucide/box
---

# Harness

**Run agents in a sandboxed container — ready to drop into any project.**

Harness wraps Docker around three open-source coding agents —
[pi](https://pi.dev/), [opencode](https://opencode.ai), and
[hermes](https://github.com/NousResearch/hermes-agent) — so you can point
one at a directory (or file) without giving it access to your entire machine.

## Why Harness?

- **Sandboxed by default** — capability-dropped container with `no-new-privileges`;
  the agent only sees the directory you mount.
- **Three agents, one CLI** — switch between `pi`, `opencode`, and `hermes` with
  `-a`. Same flags, same flow.
- **Supply-chain hardened** — images are signed and verified with cosign and SLSA
  provenance on every run; dependencies are pinned and verified.
- **Local-first** — defaults to LM Studio with `gemma-4-e4b`. Drop in an
  `--env-file` to use Anthropic, OpenRouter, OpenAI, Gemini, and others.
- **Stateful or one-shot** — interactive runs persist agent state; one-shot
  prompts stay ephemeral.
- **Zero install** — `npx @boldblackai/harness` just works.

## Quick start

Docker is required. By default, harness uses LM Studio locally:

```bash
lms daemon up
lms get google/gemma-4-e4b
```

Then run:

```bash
npx @boldblackai/harness -p "write a fizzbuzz in Go"
```

See the [Getting Started](getting-started.md) guide for more details.

## Choose an agent

| Agent | Description | Best for |
|-------|-------------|----------|
| [pi](agents/pi.md) | Default agent from [pi.dev](https://pi.dev/) | General-purpose coding |
| [opencode](agents/opencode.md) | Terminal-based agent from [opencode.ai](https://opencode.ai) | Quick one-off tasks |
| [hermes](agents/hermes.md) | Full-featured agent from [NousResearch](https://github.com/NousResearch/hermes-agent) | Long-running "claw" deployments |
