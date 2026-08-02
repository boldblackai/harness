# Integration Tests: Real End-to-End Container Tests

**Date:** 2026-07-31
**Status:** Proposed

## Goal

Add an integration test suite that exercises the full runtime path — container
spawn → agent boot → inference call → output through harness stdout → clean
exit — against real containers and real LLM inference.

Current CI covers CLI argv construction (shim-based e2e tests), image builds
(`pr-build.yml`, `docker.yml`), and automated releases (`tag-on-merge.yml`).
The entire path *inside* the container — entrypoint execution, agent
initialization, env-file forwarding, inference connectivity, output flow — is
unverified. A regression in any of these is invisible until a user hits it.

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

## Design

A single integration test tier that runs **post-merge on `main`** and via
**`workflow_dispatch`**. It runs each adapter as a one-shot prompt against a
real OpenRouter endpoint and asserts a clean exit with non-empty output.

This is deliberately simple:

- **No mock layer.** Mocking the LLM adds complexity (service containers, mock
  configs, mock placement decisions) without meaningfully de-risking the
  container plumbing — the runtime path is the same whether the inference
  endpoint is real or simulated. The only hop being simulated is the one harness
  has the *least* control over.
- **No PR trigger.** Shim-based e2e tests remain the PR gate. Integration tests
  run post-merge on `main` and **gate releases** — a release commit whose
  integration tests fail blocks the release. They remain off PR branches to keep
  PR feedback fast and free, and to avoid spending API budget on every push to a
  feature branch.
- **Cross-platform by default.** Without service containers, the same workflow
  structure runs on both Linux and macOS runners with no platform-specific mock
  infrastructure.

## Secret Flow

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

## Platforms

The matrix covers both container runtimes harness ships:

| Runtime | Runner | Architecture |
|---------|--------|-------------|
| Docker | `ubuntu-latest` | amd64 |
| Docker | `ubuntu-24.04-arm` | arm64 |
| Apple Container | `macos-26` | arm64 |

macOS 26 GitHub runners are generally available as of July 2026. Apple's
`container` CLI is tested in real CI via `HARNESS_CONTAINER_RUNTIME=apple`,
exercising the same runtime abstraction harness ships to users.

## Assertions

| Assertion | Proves |
|-----------|--------|
| Exit code 0 | Image boots, agent runs, inference endpoint reachable, clean shutdown |
| Non-empty stdout | Response flowed through harness correctly |

Content assertions are intentionally omitted. Real model output is
non-deterministic; asserting on specific substrings would be fragile. The goal
is connectivity and provider compatibility, not output quality.

## Cosign Verification: Out of Scope

The workflow builds the image locally in-job (same pattern as `pr-build.yml`)
and passes `HARNESS_IMAGE_TAG` to skip the cosign check. Integration tests must
complete before the release is cut, so they cannot wait on `docker.yml` to
publish the signed SHA-tagged image to `ghcr.io`. Cosign verification remains
covered by `docker.yml`, which signs and attests every image on push to `main`
(and applies version tags on release commits via the `tag-on-merge.yml`
pipeline).

## Image Source

The image is **built locally in-job**, following the same pattern as
`pr-build.yml` (local registry service for Docker). This keeps the test
self-contained — it does not depend on `docker.yml` having finished publishing
to `ghcr.io`.

## Relationship to the Release Pipeline

The release pipeline (`tag-on-merge.yml` → `docker.yml`) is fully automated: a
`release v*` commit on `main` triggers npm OIDC publishing, git tag creation,
GitHub release, and Docker image builds with version tags. **Integration tests
gate this pipeline** — the release job waits for the integration test job to
pass before proceeding. A failed integration test on a release commit blocks the
release until the runtime-path regression is fixed. This elevates integration
tests from informational to a hard release gate, while keeping them off PR
branches so the shim-based e2e tests remain the fast merge gate.

## Proposed Workflow

The integration workflow runs on `push: main` and via `workflow_dispatch`. The
`tag-on-merge.yml` release job depends on its success via
`workflow_run` gating — it only proceeds when the integration workflow reports
`completed` with conclusion `success` on the same commit.

```yaml
# .github/workflows/integration.yml
name: Integration Tests

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  smoke:
    strategy:
      fail-fast: false
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
      # Build image locally (base + adapter variant)
      # Write OPENROUTER_API_KEY to temp .env
      # Run each adapter:
      #   HARNESS_CONTAINER_RUNTIME=<runtime> harness --agent <agent> -m deepseek/deepseek-v4-flash-0731 -p "say OK" -e /tmp/.env
      # Assert: exit 0, non-empty stdout
```

The `tag-on-merge.yml` release job gates on this workflow via a
`workflow_run` check (or an equivalent required-status check), so a release
commit whose integration tests fail does not cut a release.

All three adapters (`hermes`, `opencode`, `pi`) get a one-shot prompt per
matrix leg. Adapter-specific breakage — entrypoint differences, env var
forwarding, mount differences — surfaces independently.

## Cost Control

- `deepseek/deepseek-v4-flash-0731` via OpenRouter (cheapest valid model)
- Single short prompt per adapter (one inference call per adapter per leg)
- 90-second timeout per test
- Post-merge only (not on every push to a PR branch)
- macOS leg runs the Docker test target (via `HARNESS_CONTAINER_RUNTIME=apple`),
  not a separate real-tier job

## What This Does Not Replace

The shim-based e2e tests remain the fast, free gate for CLI argv construction.
They run on every push and provide sub-second feedback for flag parsing, mount
construction, and adapter command assembly. The integration test suite is
additive — it covers the runtime path the shim tests cannot reach.

The release pipeline (`tag-on-merge.yml` → `docker.yml`) automates npm
publishing, Docker image builds, cosign signing, and GitHub releases. The
integration test suite gates it: the release job does not proceed until
integration tests pass on the same commit.

## Model

The smoke test uses `deepseek/deepseek-v4-flash-0731` via OpenRouter — the
cheapest option that still produces valid output for a one-shot prompt. Pinned
in the workflow via `OPENROUTER_MODEL`.
