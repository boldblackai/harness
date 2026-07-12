---
name: check-deps
description: >
  Check whether pinned dependencies in the harness Dockerfiles have newer versions available.
  Use this skill whenever the user asks to check for dependency updates, see if
  packages are outdated, check for updates, review pinned versions, or any
  variation of "are deps up to date". Triggers on: "check deps", "check for
  updates", "are dependencies up to date", "update deps check", "any new
  versions", "deps outdated", "bump dependencies".
---

# Dependency Version Check

This project pins nine external dependencies across its Dockerfiles. Check each one for updates and report what's current vs. what's available.

## Dependencies to check

| Dep | File | What's pinned | How to find latest |
|-----|------|--------------|-------------------|
| `@earendil-works/pi-coding-agent` | `Dockerfile` ~L56 | npm version in `pnpm install -g @earendil-works/pi-coding-agent@<VER>` | `npm show @earendil-works/pi-coding-agent version` |
| `opencode-ai` | `Dockerfile.opencode` ~L6 | npm version in `pnpm install -g opencode-ai@<VER>` | `npm show opencode-ai version` |
| `hermes-agent` | `Dockerfile.hermes` ~L91 | git tag in `--branch <TAG>` | `gh release list --repo NousResearch/hermes-agent --limit 5` |
| `gh` (GitHub CLI) | `Dockerfile` ~L5 | `ARG GH_VERSION=<VER>` | `gh release list --repo cli/cli --limit 5` |
| `cosign` | `Dockerfile.hermes` ~L12 | `ARG COSIGN_VERSION=<VER>` | `gh release list --repo sigstore/cosign --limit 5` |
| `uv` | `Dockerfile.hermes` ~L10–11 | `ARG UV_VERSION=<VER>` + `ARG UV_DIGEST=sha256:...` | `gh release list --repo astral-sh/uv --limit 5` |
| `pnpm` | `Dockerfile` ~L51 | version in `corepack prepare pnpm@<VER>` | `npm show pnpm version` |
| `mise` | `Dockerfile` ~L61–65 | `ENV MISE_VERSION=<VER>` + `MISE_AMD64_SHA256` / `MISE_ARM64_SHA256` checksums | `gh release list --repo jdx/mise --limit 5` |
| `debian:stable-slim` | `Dockerfile` L1 | digest in `FROM debian:stable-slim@sha256:...` | `docker manifest inspect debian:stable-slim` — see note below |

## Steps

1. **Read all pinned versions in parallel** — use `grep` or `Read` on the relevant Dockerfiles. Extract:
   - npm package versions (pattern: `@<VERSION>`)
   - GitHub release ARGs (pattern: `ARG <NAME>_VERSION=`)
   - hermes-agent git tag (pattern: `--branch <tag>`)
   - uv digest (pattern: `ARG UV_DIGEST=sha256:`)
   - debian digest (pattern: `FROM debian:stable-slim@sha256:`)
   - pnpm version (pattern: `corepack prepare pnpm@<VER>`)
   - mise version + checksums (pattern: `ENV MISE_VERSION=` plus `MISE_AMD64_SHA256` / `MISE_ARM64_SHA256`)

2. **Fetch latest versions in parallel** — run all version checks at the same time:
   - npm packages: `npm show @earendil-works/pi-coding-agent version`, `npm show opencode-ai version`, `npm show pnpm version`
   - GitHub releases: `gh release list --repo <owner/repo> --limit 5` for hermes-agent, cli/cli, sigstore/cosign, astral-sh/uv, jdx/mise
   - debian: `docker manifest inspect debian:stable-slim 2>/dev/null | python3 -c "import sys,json; m=json.load(sys.stdin); print(m.get('manifests',[{}])[0].get('digest','') if 'manifests' in m else m.get('config',{}).get('digest',''))"` — or simpler: `docker pull debian:stable-slim 2>&1 | grep -E 'Digest:|sha256:'`

3. **Parse GitHub release output** — `gh release list` returns columns: Title / Type / Tag / Published. The tag is in column 3. Strip leading `v` for semver comparison. Skip tags containing `-rc`, `-alpha`, `-beta`, or `-pre` unless all releases are pre-releases.

4. **7-day cooldown check (all dependencies)** — Every dependency must be at least 7 days old before recommending an upgrade. Apply this to **all** dependencies, not just hermes-agent:

   - **npm packages** (`@earendil-works/pi-coding-agent`, `opencode-ai`, `pnpm`): Get the publish date with `npm show <package> time` or `npm show <package> --json` and parse the `modified` / `created` field. Compute days since release.

   - **GitHub releases** (`gh`, `cosign`, `uv`, `hermes-agent`, `mise`): Use the publish date from the API response (`published_at` field when using `curl -s https://api.github.com/repos/<owner/repo>/releases?per_page=5` or column 4 from `gh release list`). Compute days since release.

   - **hermes-agent** and **mise** tags follow `vYYYY.M.DD` (e.g. `v2026.4.23` = April 23 2026). Parse the date from the tag:

     ```bash
     python3 -c "
     from datetime import date
     tag = 'v2026.4.23'
     y,m,d = tag.lstrip('v').split('.')
     release = date(int(y), int(m), int(d))
     print((date.today() - release).days)
     "
     ```

   - **debian:stable-slim**: Base image digests are not subject to the cooldown — they rotate frequently with security patches. Report if different but don't block.

   If the latest release is **fewer than 7 days old**, mark it as `on cooldown 🕐` and do **not** recommend upgrading, even if it is newer than the pinned version.

   The only exception: if the user explicitly says to override the cooldown, skip this check for the specified dependency.

5. **Compare and report** — produce a clean table:

```text
| Dependency                    | Pinned       | Latest       | Status          |
|-------------------------------|--------------|--------------|-----------------|
| @earendil-works/pi-coding-agent | 0.79.2       | 0.79.7       | up to date      |
| opencode-ai                   | 1.14.18      | 1.14.18      | up to date      |
| hermes-agent                  | v2026.4.16   | v2026.4.20   | on cooldown 🕐  |
| gh                            | 2.91.0       | 2.91.0       | up to date      |
| cosign                        | 3.0.6        | 3.0.6        | up to date      |
| uv                            | 0.11.6       | 0.11.9       | outdated ⬆      |
| pnpm                          | 10.33.0      | 10.33.0      | up to date      |
| mise                          | 2026.4.23    | 2026.4.23    | up to date      |
| debian:stable-slim            | sha256:e51b… | sha256:e51b… | up to date      |
```

1. **For each outdated dep, show the exact edit needed** — file path, the current line, and what it should change to. Be specific so the user can apply the update immediately or ask you to do it.

## Notes on specific deps

**uv**: Two things need updating together — `UV_VERSION` and `UV_DIGEST`. The `UV_DIGEST` must be the **multi-arch index digest** (not a per-platform manifest digest). The attestation verification step queries `https://api.github.com/repos/astral-sh/uv/attestations/${UV_DIGEST}`, and attestations are only published at the index level — a per-arch digest will return 404 and break the build. Look up the index digest with `docker buildx imagetools inspect ghcr.io/astral-sh/uv:<NEW_VERSION> 2>&1 | head -4` and take the `Digest:` value from the top-level output (the line after `Name:`). Report both `UV_VERSION` and `UV_DIGEST` values.

**debian:stable-slim**: The digest pins the exact image layer. If `docker pull` reports a different digest than what's in the Dockerfile, the base image has been updated. This requires re-pulling to get the new digest — mention this to the user rather than computing it automatically, since a pull may not always be desirable.

**pnpm**: Pinned in two places — `Dockerfile` line ~51 (`corepack prepare pnpm@<VER>`) and `package.json` `packageManager` field. If updating, both need to change.

**mise**: Three things need updating together — `MISE_VERSION`, `MISE_AMD64_SHA256`, and `MISE_ARM64_SHA256`. The checksums are per-arch `sha256` values pulled from the release's `SHASUMS256.txt` (`https://github.com/jdx/mise/releases/download/v<VER>/SHASUMS256.txt`). Match against the `mise-v<VER>-linux-x64` and `mise-v<VER>-linux-arm64` lines respectively. mise tags follow `vYYYY.M.DD`, same date scheme as hermes-agent — the cooldown date parser applies directly.
