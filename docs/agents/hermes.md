---
icon: lucide/bot
---

# hermes

[`hermes`](https://github.com/NousResearch/hermes-agent) by NousResearch is a full-featured agent supporting many providers. It is the recommended choice for long-running "claw" deployments.

## Local mode

```bash
npx @boldblackai/harness -a hermes -p "add tests"
```

LM Studio context length should be at least 64k tokens.

## Cloud mode

Pass `--env-file` to enter cloud mode — the agent auto-detects the provider from env vars.

```bash
echo "ANTHROPIC_API_KEY=sk-ant-***" > .env
npx @boldblackai/harness -a hermes -e .env -p "add tests"
npx @boldblackai/harness -a hermes -e .env -m openrouter/auto -p "add tests"
```

Common keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`. [See full list](https://github.com/NousResearch/hermes-agent/blob/main/.env.example).

The `-m` flag takes `provider/model` format.

## Deploying as a claw

Hermes can be deployed as a long-running persistent agent ("claw") reachable over a messaging gateway like Telegram. See the deployment guides:

- [fly.io](../deploying/fly.md)
- [Kubernetes](../deploying/k8s.md)
- [AWS (ECS Fargate or EC2 + SSM)](../deploying/aws.md)
