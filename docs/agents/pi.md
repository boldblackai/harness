---
icon: lucide/cpu
---

# pi (default agent)

[`pi`](https://pi.dev/) is the default agent. It supports many cloud providers and works with LM Studio locally.

## Local mode

Pi defaults to LM Studio with `google/gemma-4-e4b` (16k context is sufficient):

```bash
npx @capotej/harness -p "write a fizzbuzz in Go"
```

You can specify a different local model with `-m`. HuggingFace-style names with slashes work correctly:

```bash
npx @capotej/harness -m "qwen/qwen3.5-9b" -p "write a fizzbuzz in Go"
```

## Cloud mode

Pass an `--env-file` containing any supported API key:

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

See the [full provider list](https://github.com/badlogic/pi-mono/blob/c779c14e91bc2ea65143e59b0dc1baf3646ba8c9/packages/coding-agent/docs/providers.md#api-keys) for more options.

## Examples

```bash
# One-shot prompt
npx @capotej/harness -p "add a login endpoint"

# With a specific model
npx @capotej/harness -m anthropic/claude-sonnet-4-5 -p "refactor auth"

# Interactive session (no -p)
npx @capotej/harness
```

The `-m` flag is passed directly to pi as `--model`.
