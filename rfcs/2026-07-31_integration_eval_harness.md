# Integration & Evaluation Harness: Real End-to-End CI Tests

**Date:** 2026-07-31
**Status:** Proposed

## Goal

Add a two-tier integration test suite that exercises the full runtime path —
container spawn → agent boot → inference call → output through harness stdout →
clean exit — against real containers and (optionally) real LLM inference.

Current CI covers CLI argv construction (shim-based e2e tests) and image builds
(`pr-build.yml`, `docker.yml`). The entire path *inside* the container —
entrypoint execution, agent initialization, env-file forwarding, inference
connectivity, output flow — is unverified. A regression in any of these is
invisible until a user hits it.

## Motivation

The shim-based e2e tests prove harness emits the right `docker`/`container`
argv. They do not prove that what the container *does* with those args works.
Concretely, the following steps are untested in CI today:

1. ~~CLI parses args → constructs docker argv~~ ✅ (shim tests)
2. Image pulled / cached locally — ❌
3. Container spawns with correct mounts, caps, security opts — ❌
4. Entrypoint executes (`entrypoint-hermes.sh` etc.) — ❌
5. Agent initializes (boots without crashing) — ❌
6. Agent reads API key from env file → makes real inference call — ❌
7. Response flows back through harness stdout — ❌
8. Exit code 0, container cleaned up — ❌

Steps 2–8 are the coverage gap this RFC closes.

Each adapter (pi, opencode, hermes) has its own entrypoint, env-var forwarding,
and mount setup. Adapter-specific breakage — an entrypoint that sources the
wrong file, an env var that doesn't propagate — can only be caught by actually
running the adapter in a container.

## Design: Two-Tier Strategy

A single test tier cannot satisfy both "free + deterministic on every PR" and
"exercises real inference." The design splits these concerns:

| Tier | LLM | Cost | Deterministic | Trigger | What it exercises |
|------|-----|------|---------------|---------|-------------------|
| **Mock** | MockLLM sidecar | Free | Yes | Every PR | Container plumbing: image build, mounts, entrypoint, env forwarding, agent boot, API call format, output flow |
| **Real** | OpenRouter | $ per run | No | Post-merge on main, `workflow_dispatch` | Everything mock covers + real inference connectivity, API key handling, provider compatibility |

The mock tier is the **primary gate on PRs**. It exercises the entire harness
chain — everything harness is responsible for — with only the final LLM hop
simulated. That hop is the part harness has the *least* control over, making it
the safest thing to mock.

Real inference is gated to post-merge to control cost while still catching
provider-side regressions (API changes, connectivity issues, auth failures).

## Mock Tier: MockLLM

[MockLLM](https://github.com/StacklokLabs/mockllm) (Apache 2.0,
`pip install mockllm`) provides:

- OpenAI + Anthropic compatible API endpoints (agents cannot distinguish it
  from a real provider)
- YAML-configured deterministic responses (prompt pattern → predefined response)
- Streaming support (character-by-character, with simulated network lag)
- Runs as a local server on `localhost:8000`

### Integration in CI

The mock runs as a **GitHub Actions service container**. The agent's
`OPENAI_API_BASE` is pointed at the mock server (`http://localhost:8000`), so
the agent makes its inference call against MockLLM instead of a real provider.

A YAML fixture configures the mock to return a known response for the test
prompt:

```yaml
# mockllm config fixture
- pattern: "reply with OK"
  response: "OK"
```

Because mock responses are deterministic, **content assertions become reliable**
— ask the agent "reply with OK", assert "OK" in output. This was fragile under
real inference (non-deterministic model output); the mock tier makes it
deterministic.

The mock tier needs no API key, no external network, and no provider
credentials. It runs entirely within the GitHub Actions job.

## Real Tier: OpenRouter

Post-merge on `main` (and via `workflow_dispatch` for manual triggers), a
separate job runs the same test suite against a real OpenRouter endpoint.

### Secret flow

```text
GitHub Secret (OPENROUTER_API_KEY)
  → workflow writes to temp .env file
    → harness -e /tmp/.env
      → container receives the key
        → agent makes real inference call
```

Harness's `-e` (env file) mechanism is the right abstraction. The key never
appears in the workflow YAML or process args. The `.env` file is written by
the workflow, consumed by harness, and cleaned up on job completion.

### Model selection

The real tier uses the cheapest available OpenRouter model that still produces
valid output. The test only needs a single short response — the goal is
connectivity and provider compatibility, not quality. Open questions below
track the specific model.

## Platforms

Both tiers run on a matrix of container runtimes and architectures:

| Runtime | Runner | Architecture | Status |
|---------|--------|--------------|--------|
| Docker | `ubuntu-latest` | amd64 | Ship day 1 |
| Docker | `ubuntu-24.04-arm` | arm64 | Ship day 1 |
| Apple Container | `macos-26` | arm64 | Ship day 1 |

macOS 26 GitHub runners are generally available as of July 2026. Apple's
`container` CLI can now be tested in real CI, not deferred — this is the same
runtime abstraction harness already ships (`HARNESS_CONTAINER_RUNTIME=apple`).

The macOS leg runs the Docker test target (via `HARNESS_CONTAINER_RUNTIME=apple`)
but not the real-tier OpenRouter job (macOS runners are more expensive; the
real tier on macOS can be added later if needed).

## Assertions

| Tier | Assertion | Proves |
|------|-----------|--------|
| Mock — content | stdout contains expected substring ("OK") | Agent understood prompt, response flowed through harness correctly |
| Both — smoke | Exit code 0 + non-empty stdout | Image boots, agent runs, inference endpoint reachable |
| Both — structural | stderr empty, container cleaned up | Full system behavior, no leaked errors |

## Cosign Verification: Out of Scope

Cosign verification is explicitly excluded from the integration test. The
mock tier runs on PRs, where no published image exists on `ghcr.io` — there is
nothing signed to verify against. The workflow builds the image locally (same
pattern as `pr-build.yml`) and passes `HARNESS_IMAGE_TAG` to skip the cosign
check.

Cosign verification remains covered by the existing `docker.yml` pipeline,
which signs and attests on push to `main`.

## Image Source

Both tiers **build the image locally in-job**, following the same pattern as
`pr-build.yml` (local registry service). This is required because the test
targets PRs, where no published image exists yet. The locally-built image is
tagged and passed to harness via `HARNESS_IMAGE_TAG`.

## Proposed Workflow Structure

### Mock tier: `integration-mock.yml`

```yaml
name: Integration Tests (Mock)

on:
  pull_request:
  push:
    branches: [main]

jobs:
  mock:
    strategy:
      matrix:
        include:
          - runner: ubuntu-latest
            runtime: docker
          - runner: ubuntu-24.04-arm
            runtime: docker
          - runner: macos-26
            runtime: apple
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      # Install mise + build harness CLI
      # Install Docker (Linux) or apple/container (macOS)
      # Build image locally via Makefile target
      # Start MockLLM service container (Linux) or background process (macOS)
      # Run: harness --agent hermes -p "reply with OK" -e /tmp/mock-env
      # Assert: stdout contains "OK", exit 0
```

### Real tier: `integration-real.yml`

```yaml
name: Integration Tests (Real Inference)

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  real:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Install mise + build harness CLI + Docker
      # Build image locally
      # Write OPENROUTER_API_KEY to temp .env
      # Run: harness --agent hermes -p "say hello" -e /tmp/.env
      # Assert: exit 0, non-empty stdout
```

## Cost Control

- Mock tier is free — runs on every PR at zero cost
- Real tier uses the cheapest OpenRouter model (single short response per run)
- 90-second timeout per test
- Real tier: amd64 + arm64 on Linux only (macOS deferred)
- Real tier: post-merge only, not on every push to a PR branch

## Adapters

All three adapters (`hermes`, `opencode`, `pi`) get a one-shot prompt in both
tiers. This catches adapter-specific breakage: entrypoint differences, env var
forwarding, mount differences. Each adapter has its own entrypoint script and
may surface failures the others don't.

## What This Does Not Replace

The shim-based e2e tests remain the fast, free gate for CLI argv construction.
They run on every push and provide sub-second feedback for flag parsing,
mount construction, and adapter command assembly. The integration test suite
is additive — it covers the runtime path the shim tests cannot reach.

## Open Questions

1. **Cheapest OpenRouter model** — which model is the cheapest that still
   produces valid output for the real-tier smoke test? Needs a decision and
   a pin in the workflow.

2. **MockLLM placement** — GitHub Actions service container (clean separation,
   Linux only) vs. a process spawned inside the harness container (works on
   macOS too, but couples the mock to the test target). The macOS leg may
   force the in-container approach since GitHub Actions service containers
   don't support macOS runners.

3. **Persistence mode** — should the mock tier also verify non-ephemeral mode
   (container persists data across runs), or stick to ephemeral one-shots?
   Persistence testing adds complexity (multi-run sequencing) but covers
   another untested path.

4. **MockLLM as test fixture** — should MockLLM be added to the harness Docker
   image itself (available for users to test locally), or kept external in the
   CI workflow only?

## Future Extensions

- **Canary job** — a separate hourly job that makes a single cheap OpenRouter
  call, useful for distinguishing provider outages from code regressions when
  the real tier fails post-merge.
- **Persistence integration test** — multi-run sequence that verifies data
  survives across container restarts.
- **Eval harness** — deterministic prompts with expected output patterns, run
  against multiple models to track provider behavior over time.
