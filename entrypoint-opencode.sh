#!/bin/bash
set -e

# Disable in-container self-update notifications (#100).
export OPENCODE_DISABLE_AUTOUPDATE=true
export OPENCODE_DISABLE_PRUNE=true

# Shared env setup (routes git's global config into persisted ~/.config).
# shellcheck disable=SC1091
. /etc/harness/setup-env.sh

if [ -z "$HARNESS_CLOUD_MODE" ]; then
	# Local mode: use LM Studio config and default model
	export OPENCODE_CONFIG=/etc/opencode/lmstudio.json
	export OPENCODE_MODEL="${OPENCODE_MODEL:-lmstudio/google/gemma-4-e4b}"
else
	# Cloud mode: detect provider from env vars
	if [ -n "$ANTHROPIC_API_KEY" ]; then
		export OPENCODE_CONFIG=/etc/opencode/anthropic.json
		export OPENCODE_MODEL="${OPENCODE_MODEL:-anthropic/claude-sonnet-4-6}"
	elif [ -n "$OPENAI_API_KEY" ]; then
		export OPENCODE_CONFIG=/etc/opencode/openai.json
		export OPENCODE_MODEL="${OPENCODE_MODEL:-openai/gpt-5.4}"
	elif [ -n "$GOOGLE_API_KEY" ]; then
		export OPENCODE_CONFIG=/etc/opencode/google.json
		export OPENCODE_MODEL="${OPENCODE_MODEL:-google/gemini-3.1-pro}"
	elif [ -n "$ZAI_API_KEY" ]; then
		export OPENCODE_CONFIG=/etc/opencode/zai.json
		export OPENCODE_MODEL="${OPENCODE_MODEL:-zai/glm-5.1}"
	elif [ -n "$OPENROUTER_API_KEY" ]; then
		export OPENCODE_CONFIG=/etc/opencode/openrouter.json
		export OPENCODE_MODEL="${OPENCODE_MODEL:-openrouter/auto}"
	fi
fi

exec "$@"
