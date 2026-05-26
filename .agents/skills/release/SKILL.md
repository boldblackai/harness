---
name: release
description: Automate releasing the harness npm package. Use this skill whenever the user wants to cut a release, publish a new version, bump the version, tag a release, update the CHANGELOG, or run npm publish. Triggers on phrases like "release version X", "cut a release", "publish", "bump to X.X.X", "tag this release", "release the project", or any combination of version bumping + publishing intent. Always use this skill for release work — don't attempt ad-hoc release steps without it.
---

# Release Skill for `harness`

Automates the full release pipeline: pre-flight checks → version bump → CHANGELOG → build → publish → tag → GitHub release.

## Step 1: Pre-flight checks (abort on failure)

**Main bookmark is up to date** — Verify that the local `main` bookmark and `main@origin` point to the same commit. In jj, remote bookmarks use `<bookmark>@<remote>` syntax (not `origin/<bookmark>`). Run:

```bash
jj log -r "main" --no-graph -T 'commit_id ++ "\n"'
jj log -r "main@origin" --no-graph -T 'commit_id ++ "\n"'
```

If they differ, there are unpushed commits on `main`. Inform the user:

> "Aborting: local main is ahead of main@origin. Push your commits first with `jj git push`."

**Clean working state** — Run `jj status`. If there are uncommitted changes beyond what you're about to create (package.json + CHANGELOG.md), warn the user and ask whether to proceed.

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

**Dockerfile dependency changes** — Diff `Dockerfile`, `Dockerfile.opencode`, and `Dockerfile.hermes` against the last tag to find any version bumps to installed tools (e.g. `@mariozechner/pi-coding-agent`, `opencode-ai`, `hermes-agent`, `uv`, `pnpm`, `debian`, etc.). If any are found, include a `### Dependency Updates` section listing each change as `- updated <package> from <old> to <new>`.

**Upstream release notes for pi, opencode, and hermes-agent** — If any of these three were bumped, fetch the release notes for every version between the old pin (exclusive) and the new pin (inclusive) and include them in a `### Upstream Release Notes` section. Run the fetches in parallel:

- `@mariozechner/pi-coding-agent`: use `npm show @mariozechner/pi-coding-agent versions --json` to enumerate intermediate versions, then `gh release view <tag> --repo badlogic/pi-mono --json tagName,body` for each (tags match npm versions with a `v` prefix, e.g. `v0.70.2`)
- `opencode-ai`: `gh release view <tag> --repo sst/opencode --json tagName,body` for each version between old and new (tags are prefixed with `v`)
- `hermes-agent`: `gh release view <tag> --repo NousResearch/hermes-agent --json tagName,body` for each tag between old and new

Summarize each release in 2–4 bullet points (new features, breaking changes, notable fixes). Don't paste the full release body verbatim — condense it. Format the section like:

```markdown
### Upstream Release Notes

#### @mariozechner/pi-coding-agent 0.67.68 → 0.70.2

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

## Step 5b: Update pinned hermes image tags in deploy guides

The hermes claw deploy docs pin the upstream image tag (e.g. `ghcr.io/capotej/harness:hermes-1.6.4`). On every release, bump **all** of these to match the new `package.json` version:

| File | What to update |
|---|---|
| `docs/deploying-to-fly.md` | `fly.toml` `[build] image`, and the `FROM ghcr.io/capotej/harness:hermes-…` example in "Customizing the claw" |
| `docs/deploying-to-aws.md` | `HARNESS_IMAGE` export, ECS task-definition `"image"`, and the EC2 systemd `docker run` image |
| `docs/deploying-to-k8s.md` | Architecture table, prerequisites, and Deployment manifest `image:` |

Search each file for `ghcr.io/capotej/harness:hermes-` and replace the version suffix with the new release version. A single pass with:

```bash
# Preview first — every match should be the old hermes-<version> tag
rg 'ghcr\.io/capotej/harness:hermes-[0-9.]+' docs/deploying-to-fly.md docs/deploying-to-aws.md docs/deploying-to-k8s.md
```

Then replace every `hermes-<old-version>` with `hermes-<new-version>` across those three files. Do not edit `README.md` for this — it only links to the deploy guides, it no longer embeds a pinned tag.

## Step 6: Build

```bash
pnpm build
```

Stop if this fails.

## Step 7: Commit and push the release

In jj, file changes are automatically snapshotted in the working-copy commit. Describe it and move to a new empty commit:

```bash
jj describe -m "release v<version>"
jj new
```

Advance the main bookmark to the release commit, then push:

```bash
jj bookmark set main -r @-
jj git push --bookmark main
```

## Step 8: Publish to npm

npm publish requires an OTP and cannot be automated. Tell the user:

> "Please run `npm publish` (with `--otp=<code>` if prompted for 2FA). Let me know when it succeeds and I'll continue."

Wait for the user to confirm success before proceeding to Step 9.

## Step 9: Create and push the tag

Create the tag locally pointing to the release commit (one behind `@`, the current empty working copy):

```bash
jj tag set v<version> -r @-
```

Push it to the remote (jj doesn't support pushing tags directly; use git):

```bash
git push --tags
```

## Step 10: Create GitHub release

Extract the changelog section for this version — everything from `## [<version>]` down to (but not including) the next `## [` entry.

```bash
gh release create v<version> \
  --title "v<version>" \
  --notes "<changelog-entry>"
```

## Step 11: Post-flight — verify CI succeeded

After creating the GitHub release, poll until the release-triggered workflow run completes:

```bash
gh run list --repo <owner>/<repo> --event release --limit 1
```

Use the run ID to watch for completion:

```bash
gh run view <run-id> --repo <owner>/<repo>
```

Check that **all jobs** show `✓` (success). Pay particular attention to:

- `build-variant (hermes, ...)` — most likely to fail due to the uv attestation verification step
- `merge-variant (hermes)` and `merge-variant (opencode)` — these push the versioned image tags

If any job failed, run:

```bash
gh run rerun <run-id> --failed --repo <owner>/<repo>
```

Then wait for it to complete and verify again before reporting success.

Only report the release as complete once the entire workflow is green.

## Final report

Tell the user:

- Version released
- The CHANGELOG entry added
- GitHub release URL (from `gh release create` stdout)
- CI status (all jobs green)
