---
icon: lucide/shield-check
---

# Security

Harness layers protections at runtime, image, and dependency level.

## Sandbox

Each run starts the container with:

- `--cap-drop=ALL --cap-add=NET_RAW` — minimal capability set
- `--security-opt seccomp=...` — inline seccomp profile blocks `socket(AF_ALG)`
  to prevent kernel crypto API access (a known container escape vector)
- Only your mounted directory (or single file with `-f`) is visible to the agent

## Image verification

By default, harness verifies that the container image was signed by the official
CI workflow and carries a valid SLSA provenance attestation. This requires
[cosign](https://github.com/sigstore/cosign):

```bash
brew install cosign
```

Verified digests are cached at `~/.cache/harness/cosign-verified.json` so
verification only runs once per image. Skip with `--no-verify` (or by setting
`HARNESS_IMAGE_TAG`, which implies skip):

```bash
npx @capotej/harness --no-verify -p "write a fizzbuzz in Go"
```

## Dependency cooldown

The image build enforces a 7-day cooldown on dependency resolution — a guard
against supply-chain compromises that are typically discovered and yanked within
hours.

- **pnpm**: `PNPM_MINIMUM_RELEASE_AGE=10080` (minutes) via environment variable
- **uv**: `--exclude-newer` set to 7 days ago at image build time

The cooldown applies to transitive dependencies too. Older packages install
normally.
