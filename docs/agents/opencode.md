---
icon: lucide/terminal
---

# opencode

[`opencode`](https://opencode.ai) defaults to LM Studio in local mode. Pass `--env-file` to enter cloud mode — the agent auto-detects the provider from whichever API key is in the file.

## Local mode

```bash
npx @capotej/harness -a opencode -p "write a fizzbuzz in Go"
```

When using LM Studio locally, set the model's context length to at least 32k tokens.

## Cloud mode

The entrypoint detects the provider from your env file. Priority order: Anthropic > OpenAI > Google > ZAI > OpenRouter.

```bash
echo "OPENROUTER_API_KEY=sk-or-***" > .env
npx @capotej/harness -a opencode -e .env -p "refactor the auth module"
npx @capotej/harness -a opencode -e .env -m anthropic/claude-sonnet-4-5 -p "add tests"
```

Supported keys:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `ZAI_API_KEY`
- `OPENROUTER_API_KEY`

The `-m` flag takes a bare model name; the provider prefix is added automatically.

## Force local mode

To pass env vars but stay in local mode:

```bash
npx @capotej/harness -a opencode -e .env --local -p "refactor the auth module"
```
