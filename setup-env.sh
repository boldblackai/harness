#!/bin/bash
# Common environment setup shared by all harness entrypoints.
# Sourced (never executed directly) so the exports propagate to the agent.

# Route git's global config into the persisted ~/.config. Harness persists
# ~/.config at the project level, but NOT ~/.gitconfig (git's default), so an
# identity set via `git config --global` would otherwise be written to the
# ephemeral ~/.gitconfig and lost. Pointing GIT_CONFIG_GLOBAL here makes it
# survive across runs.
mkdir -p /home/harness/.config
export GIT_CONFIG_GLOBAL=/home/harness/.config/gitconfig

# Seed the gitconfig on first run so HTTPS pushes/pulls to GitHub authenticate
# via the gh CLI credential helper (the token gh stores after `gh auth login`).
# Only written when the file is absent, so an identity set via
# `git config --global user.name/email` (or any other manual edits) is preserved
# across runs.
if [ ! -f "$GIT_CONFIG_GLOBAL" ]; then
	cat >"$GIT_CONFIG_GLOBAL" <<'EOF'
[credential "https://github.com"]
	helper =
	helper = !/usr/local/bin/gh auth git-credential
[credential "https://gist.github.com"]
	helper =
	helper = !/usr/local/bin/gh auth git-credential
EOF
fi
