---
name: release
description: Automate releasing the harness npm package. Use this skill whenever the user wants to cut a release, publish a new version, bump the version, tag a release, update the CHANGELOG, or run npm publish. Triggers on phrases like "release version X", "cut a release", "publish", "bump to X.X.X", "tag this release", "release the project", or any combination of version bumping + publishing intent. Always use this skill for release work — don't attempt ad-hoc release steps without it.
---

# Release Skill for `harness`

Automates the full release pipeline: pre-flight checks → version bump → CHANGELOG → build → open release PR → (user merges) → tag (triggers npm publish via OIDC trusted publishing) → verify npm → GitHub release → verify CI.

> **npm publishing is fully automated via [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC).** Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which authenticates to npm via a short-lived OIDC token — no long-lived npm token, no manual `npm publish`, no OTP. Provenance attestations are generated automatically.
>
> **Release model:** The agent prepares the release commit (version bump + CHANGELOG + deploy guide tags) and opens a PR. A maintainer reviews and merges. The agent then tags the merge commit, which triggers the automated publish. The trust boundary is "can merge a PR to main" = "can release."
>
> **Prerequisite (one-time, manual on npmjs.com):** Configure the trusted publisher for `@boldblackai/harness` under Settings → Trusted Publisher → GitHub Actions: org=`boldblackai`, repo=`harness`, workflow filename=`publish.yml`. Then under Settings → Publishing access, select "Require two-factor authentication and disallow tokens" (recommended) — OIDC publishes are unaffected by this setting.

## Step 1: Pre-flight checks (abort on failure)

**Main bookmark is up to date** — Verify that the local `main` bookmark and `main@origin` point to the same commit. In jj, remote bookmarks use `<bookmark>@<remote>` syntax (not `origin/<bookmark>`). Run:

```bash
jj log -r "main" --no-graph -T 'commit_id ++ "\n"'
jj log -r "main@origin" --no-graph -T 'commit_id ++ "\n"'
```

If they differ, there are unpushed commits on `main`. Inform the user:

> "Aborting: local main is ahead of main@origin. Push your commits first with `jj git push`."

**Clean working state** — Run `jj status`. If there are uncommitted changes beyond what you're about to create (`package.json` + `CHANGELOG.md` + deploy guides), warn the user and ask whether to proceed.

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

Edit the `version` field directly in `package.json`. Do not use `npm version` — it creates git commits automatically and would interfere with the jj workflow.

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

## Step 7: Commit the release and create a branch

In jj, file changes are automatically snapshotted in the working-copy commit. Describe it and move to a new empty commit:

```bash
jj describe -m "release v<version>"
jj new
```

Create a release branch pointing to the release commit (do NOT move main):

```bash
jj bookmark set release/v<version> -r @-
```

## Step 8: Push branch and open release PR

Push the release branch to the fork:

```bash
jj git push --bookmark release/v<version> --remote fork
```

If the fork remote doesn't exist, create it first:

```bash
git remote add fork https://github.com/BoldBlackBot/harness.git
jj git push --bookmark release/v<version> --remote fork
```

Open the PR:

```bash
gh pr create \
  --repo boldblackai/harness \
  --head BoldBlackBot:release/v<version> \
  --base main \
  --title "release v<version>" \
  --body "Release v<version>.

See CHANGELOG.md for details.

Merge to trigger the automated npm publish (OIDC trusted publishing)."
```

## Step 9: Wait for maintainer to merge the PR

**STOP HERE.** The skill cannot proceed until the PR is merged. Tell the user:

> "Release PR #N is up: <url>. Review and merge it, then tell me to continue."

Do not proceed to Step 10 until the user confirms the PR has been merged.

## Step 10: Tag the merge commit (triggers npm publish)

After the user confirms the PR is merged, fetch the latest main and tag the merge commit:

```bash
git fetch origin main
MERGE_SHA=$(git rev-parse origin/main)
git tag v<version> $MERGE_SHA
git push origin v<version>
```

The tag push triggers `.github/workflows/publish.yml`, which publishes to npm via OIDC trusted publishing — automatically, no manual intervention needed.

> **Important:** Tag `origin/main` (the merge commit), not the branch commit. The PR was squash- or rebase-merged, so the SHA on main is different from the branch SHA.

## Step 11: Verify npm publish succeeded

The tag push triggers `publish.yml`. Poll until it completes:

```bash
gh run list --repo boldblackai/harness --workflow publish.yml --limit 1
```

Use the run ID to watch for completion:

```bash
gh run watch <run-id> --repo boldblackai/harness
```

Once the workflow succeeds, verify the package landed on npm **with provenance attestations**:

```bash
npm view @boldblackai/harness@<version> dist --json
```

Confirm the output includes an `attestations` field (not just `signatures`). If `attestations` is missing, the publish did not generate provenance — investigate before continuing.

Do not proceed to Step 12 until the npm package is confirmed published with provenance.

## Step 12: Create GitHub release

Extract the changelog section for this version — everything from `## [<version>]` down to (but not including) the next `## [` entry.

```bash
gh release create v<version> \
  --repo boldblackai/harness \
  --title "v<version>" \
  --notes "<changelog-entry>"
```

This triggers the Docker image build workflow (`docker.yml`).

## Step 13: Post-flight — verify Docker CI succeeded

The GitHub release triggers `docker.yml`. Poll until the release-triggered workflow run completes:

```bash
gh run list --repo boldblackai/harness --event release --limit 1
```

Use the run ID to watch for completion:

```bash
gh run view <run-id> --repo boldblackai/harness
```

Check that **all jobs** show `✓` (success). Pay particular attention to:

- `build-variant (hermes, ...)` — most likely to fail due to the uv attestation verification step
- `merge-variant (hermes)` and `merge-variant (opencode)` — these push the versioned image tags

If any job failed, run:

```bash
gh run rerun <run-id> --failed --repo boldblackai/harness
```

Then wait for it to complete and verify again before reporting success.

Only report the release as complete once the entire workflow is green.

## Final report

Tell the user:

- Version released
- The CHANGELOG entry added
- Release PR URL (merged)
- npm publish status (workflow green, provenance attestations confirmed)
- GitHub release URL (from `gh release create` stdout)
- Docker CI status (all jobs green)
