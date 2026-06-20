---
icon: lucide/hard-drive
---

# Persistence

## How it works

Interactive runs (no `-p` and no piped stdin) store persistence data at:

```text
$XDG_DATA_HOME/harness/<project>/<agent>/
```

Defaults to `~/.local/share/harness/`. The `<project>` segment is the working
directory path with `/` replaced by `_` and the home prefix stripped.

This lets agents resume sessions, skip database migrations on repeat runs, and
retain memories across invocations.

## One-shot vs interactive

- **One-shot** (`-p` or piped stdin) — implicitly ephemeral, no persistence data
  is created
- **Interactive** (no `-p`, no piped stdin) — state persists automatically

Use `--ephemeral` to force-disable persistence on interactive runs.

## Per-agent persistence

Each adapter declares its own mount points:

- **pi** — `/home/harness/.pi/agent`
- **opencode** — config, share, and state directories
- **hermes** — `/home/harness/.hermes`

Per-agent [mise](https://mise.jdx.dev/) tool data and trust settings are
persisted at `<persist-root>/mise/` and `<persist-root>/mise-state/`
respectively.

## Project-level persistence

The container's `~/.config` is also persisted, but at the **project** level —
one directory above the per-agent root, at `<persist-root>/../xdg_config`. So
it's **shared across every agent** working in the same project directory,
rather than scoped per agent. (For opencode, the per-agent `~/.config/opencode`
mount nests inside this one, so it keeps its own per-agent bucket while still
sharing the rest of `~/.config`.)

What this covers:

- **git config** — harness points `GIT_CONFIG_GLOBAL` at `~/.config/gitconfig`,
  so an identity set with `git config --global user.name`/`user.email` survives
  restarts. The gitconfig is also seeded with the `gh` credential helper on
  first boot.
- **`gh` auth session** — `~/.config/gh/hosts.yml`, written by
  `gh auth login --with-token` (see [GitHub authentication](github.md)).

## Migration from old format

If an old `.harness/` directory exists in your working directory, harness will
emit a deprecation warning with migration instructions.
