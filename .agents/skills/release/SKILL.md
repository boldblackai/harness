---
name: release
description: Automate releasing the harness npm package. Use this skill whenever the user wants to cut a release, publish a new version, bump the version, tag a release, update the CHANGELOG, or run npm publish. Triggers on phrases like "release version X", "cut a release", "publish", "bump to X.X.X", "tag this release", "release the project", or any combination of version bumping + publishing intent. Always use this skill for release work — don't attempt ad-hoc release steps without it.
---

# Release Skill for `harness`

Automates the full release pipeline: pre-flight checks → version bump → CHANGELOG → build → open release PR → (maintainer merges) → CI auto-tags, publishes to npm (OIDC), creates GitHub release, builds Docker images.

> **npm publishing is fully automated via [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC).** The agent never touches npm credentials, pushes tags, or creates GitHub releases. It only opens a release PR; merging that PR triggers a chain of workflows that handle everything:
>
> 1. **`tag-on-merge.yml`** — fires when a `release`-labeled PR merges to main. Reads the version from `package.json`, pushes a `v<version>` tag, and creates the GitHub release.
> 2. **`publish.yml`** — fires on the tag push. Publishes to npm via OIDC with automatic provenance attestations.
> 3. **`docker.yml`** — fires on the GitHub release. Builds and pushes all Docker image variants.
>
> **Release model:** The trust boundary is "can merge a PR to main" = "can release." The agent has zero upstream write access — it opens the PR from its fork; the maintainer's merge triggers everything.
>
> **Prerequisite (one-time, manual on npmjs.com):** Configure the trusted publisher for `@boldblackai/harness` under Settings → Trusted Publisher → GitHub Actions: org=`boldblackai`, repo=`harness`, workflow filename=`publish.yml`. Then under Settings → Publishing access, select "Require two-factor authentication and disallow tokens" (recommended) — OIDC publishes are unaffected by this setting.

## Step 1: Pre-flight checks (abort on failure)

**Ensure working from latest main** — Fetch latest and verify local main matches remote:

```bash
git fetch origin main
git checkout main
git pull --ff-only origin main
```

If `git pull --ff-only` fails (local main has diverged), inform the user and abort.

**Clean working state** — Run `git status`. If there are uncommitted changes beyond what you're about to create (`package.json` + `CHANGELOG.md` + deploy guides), warn the user and ask whether to proceed.

**README is up to date** — Read `README.md` and the commits since the last tag (collected in Step 3). Check whether any commit introduces new CLI flags, options, agents, or user-visible behavior that isn't reflected in `README.md`. If gaps are found, list them and ask the user to update `README.md` before continuing:

> "Aborting: README.md appears out of date. The following changes may need documentation: <list>. Update README.md and re-run the release."

## Step 2: Determine the new version

- If the user gave an explicit version, use it.
- Otherwise read `version` from `package.json` and infer a semantic bump from commits since the last tag:
  - **patch** (default) — bug fixes, docs, tooling, and new features (`feat:` commits)
  - **minor** — only on user request or commits that add new user-facing CLI flags, options, or agents
  - **major** — only on user request or explicit breaking-change commit messages

Tell the user what version you chose and why before continuing.

## Step 3: Get commits since last release

```bash
# Find the last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null)

# If a tag exists:
git log ${LAST_TAG}..HEAD --oneline

# If no previous tag (first release):
git log --oneline
```

Collect these as bullet points for the changelog: `- <short-hash> <message>`

## Step 4: Update CHANGELOG.md

Get today's date:

```bash
date +%Y-%m-%d
```

Based on the commits collected, write a 1–3 sentence prose summary of what changed (new features, fixes, notable improvements). For any new user-visible features — especially new CLI flags, options, or agents — include a concrete inline example showing how to use them (e.g. `harness --flag value`). Then include the raw commit list beneath it.

**Dockerfile dependency changes** — Diff `Dockerfile`, `Dockerfile.opencode`, and `Dockerfile.hermes` against the last tag to find any version bumps to installed tools (e.g. `@earendil-works/pi-coding-agent`, `opencode-ai`, `hermes-agent`, `uv`, `pnpm`, `debian`, etc.). If any are found, include a `### Dependency Updates` section listing each change as `- updated <package> from <old> to <new>`.

**Upstream release notes for pi, opencode, and hermes-agent** — If any of these three were bumped, fetch the release notes for every version between the old pin (exclusive) and the new pin (inclusive) and include them in a `### Upstream Release Notes` section. Run the fetches in parallel:

- `@earendil-works/pi-coding-agent`: use `npm show @earendil-works/pi-coding-agent versions --json` to enumerate intermediate versions, then `gh release view <tag> --repo badlogic/pi-mono --json tagName,body` for each (tags match npm versions with a `v` prefix, e.g. `v0.70.2`)
- `opencode-ai`: `gh release view <tag> --repo sst/opencode --json tagName,body` for each version between old and new (tags are prefixed with `v`)
- `hermes-agent`: `gh release view <tag> --repo NousResearch/hermes-agent --json tagName,body` for each tag between old and new

Summarize each release in 2–4 bullet points (new features, breaking changes, notable fixes). Don't paste the full release body verbatim — condense it. Format the section like:

```markdown
### Upstream Release Notes

#### @earendil-works/pi-coding-agent 0.67.68 → 0.70.2

**v0.68.0** — <2–4 bullet summary>
**v0.68.1** — <2–4 bullet summary>
...

#### opencode-ai 1.14.18 → 1.14.25

**v1.14.19** — <2–4 bullet summary>
...

#### hermes-agent v2026.4.16 → v2026.4.23

**v2026.4.23** — <2–4 bullet summary>
```

Omit `### Dependency Updates` and `### Upstream Release Notes` entirely if there are no relevant changes.

**If CHANGELOG.md does not exist**, create it:

```markdown
# Changelog

## [<version>] - <YYYY-MM-DD>

### Summary
<1–3 sentence prose summary of what changed>

### Dependency Updates
- updated <package> from <old> to <new>

### Upstream Release Notes

#### <package> <old> → <new>
...

### Changes
- <hash> <message>
```

**If it already exists**, insert the new entry immediately after the `# Changelog` header line, before any existing entries.

## Step 5: Bump version in package.json

Edit the `version` field directly in `package.json`. Do not use `npm version` — it creates git commits and tags automatically and would interfere with the release workflow.

## Step 5b: Update hermes image tag in deploy guides

The hermes claw deploy guides pin the upstream image tag (e.g. `ghcr.io/boldblackai/harness:hermes-1.8.1`). Update every occurrence to match the new `package.json` version. Each guide exists twice — the in-repo copy (`docs/deploying-to-*.md`, linked from README) and the docs-site copy (`docs/deploying/*.md`) — keep both in sync.

```toml
image = "ghcr.io/boldblackai/harness:hermes-<new-version>"
```

Search for the pattern `hermes-[0-9]` in these files and replace all occurrences with the new version:

- `docs/deploying-to-fly.md` and `docs/deploying/fly.md`
- `docs/deploying-to-k8s.md` and `docs/deploying/k8s.md`
- `docs/deploying-to-aws.md` and `docs/deploying/aws.md`

Do not edit `README.md` — it only links to the guides.

## Step 6: Build

```bash
pnpm build
```

Stop if this fails.

## Step 7: Create release branch and commit

Create a release branch from main and commit all release changes:

```bash
git checkout -b release/v<version>
git add package.json CHANGELOG.md docs/
git commit -m "release v<version>"
```

## Step 8: Push branch and open release PR

Ensure a fork remote exists (for the agent's bot account):

```bash
git remote add fork https://github.com/BoldBlackBot/harness.git 2>/dev/null || true
```

Push the release branch:

```bash
git push -u fork release/v<version>
```

Open the PR with the `release` label — **this label is required** for `tag-on-merge.yml` to fire:

```bash
gh pr create \
  --repo boldblackai/harness \
  --head BoldBlackBot:release/v<version> \
  --base main \
  --title "release v<version>" \
  --body "Release v<version>.

See CHANGELOG.md for details.

Merging this PR will automatically:
1. Push the \`v<version>\` tag (triggers npm publish via OIDC)
2. Create the GitHub release (triggers Docker image build)

Do not add or remove the \`release\` label — it gates the automation." \
  --label release
```

> If the `release` label doesn't exist in the repo, create it first: `gh label create release --repo boldblackai/harness --description "Merging triggers the automated release pipeline" --color 0E8A16`

## Step 9: Wait for maintainer to merge the PR

**STOP HERE.** The skill cannot proceed until the PR is merged. Tell the user:

> "Release PR #N is up: <url>. Review and merge it, then tell me to continue."

Do not proceed to Step 10 until the user confirms the PR has been merged.

## Step 10: Monitor the automated release pipeline (read-only)

After the PR is merged, `tag-on-merge.yml` fires automatically. It pushes the `v<version>` tag and creates the GitHub release. The tag triggers `publish.yml` (npm OIDC), and the release triggers `docker.yml` (Docker images). All of this runs as CI workflows — the agent only monitors, never acts.

### 10a: Verify tag-on-merge ran

```bash
gh run list --repo boldblackai/harness --workflow tag-on-merge.yml --limit 1
```

Confirm the workflow succeeded. If it failed, check logs:

```bash
gh run view <run-id> --repo boldblackai/harness --log-failed
```

### 10b: Verify npm publish succeeded

The tag push triggers `publish.yml`. Poll until it completes:

```bash
gh run list --repo boldblackai/harness --workflow publish.yml --limit 1
gh run watch <run-id> --repo boldblackai/harness
```

Once the workflow succeeds, verify the package landed on npm **with provenance attestations**:

```bash
npm view @boldblackai/harness@<version> dist --json
```

Confirm the output includes an `attestations` field (not just `signatures`). If `attestations` is missing, the publish did not generate provenance — investigate before continuing.

### 10c: Verify Docker CI succeeded

The GitHub release triggers `docker.yml`. Poll until the release-triggered workflow run completes:

```bash
gh run list --repo boldblackai/harness --workflow docker.yml --limit 3
gh run view <run-id> --repo boldblackai/harness
```

Check that **all jobs** show `✓` (success). Pay particular attention to:

- `build-variant (hermes, ...)` — most likely to fail due to the uv attestation verification step
- `merge-variant (hermes)` and `merge-variant (opencode)` — these push the versioned image tags

If any job failed:

```bash
gh run rerun <run-id> --failed --repo boldblackai/harness
```

Then wait for it to complete and verify again before reporting success.

> **Note:** `gh run rerun` requires write access. If the agent's token lacks it, ask the maintainer to rerun the failed jobs.

Only report the release as complete once the entire pipeline is green.

## Final report

Tell the user:

- Version released
- The CHANGELOG entry added
- Release PR URL (merged)
- npm publish status (workflow green, provenance attestations confirmed)
- GitHub release URL
- Docker CI status (all jobs green)
